import {
  BlockNode,
  ExprNode,
  ExternDeclNode,
  ForStmtNode,
  IdentifierNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglDiagnostic,
  RsglModule,
  RsglNode,
  TemplateDeclNode,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { createBuiltinSymbols } from "./builtins";
import { diagnostic } from "./diagnostics";
import { finiteStringDomain } from "./domainChecks";
import {
  checkAssignable,
  checkEquipmentLayerListExpression,
  checkEquipmentLayerNameExpression,
  checkExpression,
  checkLocalLetDecl,
  checkObject,
  checkResourceIdExpression,
  checkStringEnumLikeExpression,
  RsglExpressionCheckContext,
  validateResourceLocationLike
} from "./expressionChecker";
import { createChildScope, createScope, lookup } from "./scopes";
import {
  anyType,
  identifierName,
  jsonType,
  numberType,
  resourceIdType,
  RsglBindOptions,
  RsglExportRecord,
  RsglImportRecord,
  RsglOutputResourcePreview,
  RsglReferenceRecord,
  RsglScope,
  RsglSemanticModel,
  RsglSymbol,
  RsglType,
  stringType,
  typeFromAnnotation,
  unknownType
} from "./types";

type CheckableBody = ResourceBodyNode | BlockNode | VariantBodyNode | MultipartBodyNode;

export function bindRsglModule(module: RsglModule, options: RsglBindOptions = {}): RsglSemanticModel {
  const binder = new RsglBinder(module, options.fileName ?? "<anonymous>", options);
  return binder.bind();
}

class RsglBinder implements RsglExpressionCheckContext {
  public readonly diagnostics: RsglDiagnostic[] = [];
  public readonly references: RsglReferenceRecord[] = [];
  private readonly symbols: RsglSymbol[] = [];
  private readonly imports: RsglImportRecord[] = [];
  private readonly exports: RsglExportRecord[] = [];
  private readonly outputResources: RsglOutputResourcePreview[] = [];
  private readonly globalScope: RsglScope = createScope("global");
  private namespace: string | undefined;

  public constructor(
    private readonly module: RsglModule,
    private readonly fileName: string,
    private readonly options: RsglBindOptions
  ) { }

  public bind(): RsglSemanticModel {
    this.module.diagnostics.forEach(item => this.diagnostics.push(item));
    for (const symbol of createBuiltinSymbols()) {
      this.define(this.globalScope, symbol);
    }

    this.predeclareTopLevel(this.module.statements, this.globalScope);
    this.checkTopLevelStatements(this.module.statements, this.globalScope);

    return {
      fileName: this.fileName,
      module: this.module,
      scope: this.globalScope,
      symbols: this.symbols,
      imports: this.imports,
      exports: this.exports,
      references: this.references,
      outputResources: this.outputResources,
      diagnostics: this.diagnostics,
      namespace: this.namespace
    };
  }

  public defineIdentifier(
    scope: RsglScope,
    identifier: IdentifierNode | null | undefined,
    kind: RsglSymbol["kind"],
    type: RsglType,
    node: RsglNode
  ): void {
    const name = identifierName(identifier);
    if (!name) {
      return;
    }
    this.define(scope, { name, kind, type, node, range: identifier?.range });
  }

  private predeclareTopLevel(statements: TopLevelStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      if (statement.kind === "ImportDecl") {
        this.recordImport(statement, scope);
      } else if (statement.kind === "ExportDecl") {
        this.recordExport(statement);
      } else if (statement.kind === "ExternDecl") {
        const id = this.externDeclId(statement);
        const kind = this.externDeclKind(statement);
        if (id && kind) {
          this.outputResources.push({ kind, id, node: statement });
        }
      } else if (statement.kind === "LetDecl") {
        this.defineIdentifier(scope, statement.name, "variable", typeFromAnnotation(statement.typeAnnotation), statement);
      } else if (statement.kind === "TableDecl") {
        this.defineIdentifier(scope, statement.name, "table", jsonType, statement);
      } else if (statement.kind === "TemplateDecl") {
        this.defineTemplate(scope, statement);
      } else if (statement.kind === "NamespaceDecl") {
        this.namespace = expressionToStaticText(statement.name) ?? this.namespace;
      } else if (statement.kind === "ResourceDecl") {
        const id = statement.id ? expressionToStaticText(statement.id) : undefined;
        this.outputResources.push({ kind: statement.resourceKind, id, node: statement });
        this.defineResource(scope, statement, id);
      }
    }
  }

  private checkTopLevelStatements(statements: TopLevelStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      if (statement.kind === "LetDecl") {
        const actualType = this.checkExpression(statement.value, scope);
        const expectedType = typeFromAnnotation(statement.typeAnnotation);
        checkAssignable(this, expectedType, actualType, statement.value);
        const name = identifierName(statement.name);
        const symbol = name ? lookup(scope, name) : undefined;
        if (symbol) {
          symbol.finiteDomain = finiteStringDomain(statement.value, scope) ?? undefined;
        }
      } else if (statement.kind === "TableDecl") {
        checkObject(this, statement.body, scope);
      } else if (statement.kind === "TemplateDecl") {
        this.checkTemplate(statement, scope);
      } else if (statement.kind === "ExternDecl") {
        this.checkExternDecl(statement, scope);
      } else if (statement.kind === "ResourceDecl") {
        this.checkResourceDecl(statement, scope);
      } else if (statement.kind === "UseDecl") {
        this.checkExpression(statement.expression, scope);
      } else if (statement.kind === "ForStmt") {
        this.checkForStatement(statement, scope);
      } else if (statement.kind === "IfStmt") {
        this.checkExpression(statement.condition, scope);
        this.checkBody(statement.thenBody, createChildScope(scope, "block"));
        if (statement.elseBody) {
          this.checkBody(statement.elseBody, createChildScope(scope, "block"));
        }
      } else if (statement.kind === "TargetDecl") {
        this.checkExpression(statement.value, scope);
      } else if (statement.kind === "OverlayDecl") {
        this.checkExpression(statement.directory, scope);
        if (statement.formatRange) {
          this.checkOverlayFormatExpression(statement.formatRange, scope);
        }
        this.checkBody(statement.body, createChildScope(scope, "block"));
      }
    }
  }

  private checkTemplate(statement: TemplateDeclNode, parentScope: RsglScope): void {
    const scope = createChildScope(parentScope, "template");
    this.checkCallableParameters(statement.parameters, scope);
    if (statement.body.kind === "ResourceBody") {
      this.checkResourceBody(statement.body, scope);
    } else {
      this.checkBody(statement.body, scope);
    }
  }

  private checkCallableParameters(parameters: TemplateDeclNode["parameters"], scope: RsglScope): void {
    const seen = new Set<string>();
    for (const parameter of parameters) {
      const name = identifierName(parameter.name);
      if (!name) {
        continue;
      }
      if (seen.has(name)) {
        this.diagnostics.push(diagnostic("rsgl.duplicateParameter", `Duplicate template parameter '${name}'.`, parameter.range));
      }
      seen.add(name);
      this.defineIdentifier(scope, parameter.name, "parameter", typeFromAnnotation(parameter.typeAnnotation), parameter);
      if (parameter.defaultValue) {
        const expectedType = typeFromAnnotation(parameter.typeAnnotation);
        const actualType = this.checkExpression(parameter.defaultValue, scope);
        checkAssignable(this, expectedType, actualType, parameter.defaultValue);
      }
    }
  }

  private checkResourceDecl(statement: ResourceDeclNode, scope: RsglScope): void {
    if (statement.id) {
      checkResourceIdExpression(this, statement.id, scope);
      validateResourceLocationLike(this, statement.id);
    }
    if (statement.impl) {
      this.checkModelImpl(statement.impl, scope);
    }
    this.checkResourceBody(statement.body, createChildScope(scope, "block"), statement.resourceKind);
  }

  private checkModelImpl(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "CallExpr") {
      checkResourceIdExpression(this, expression.callee, scope);
      expression.args.forEach(arg => checkResourceIdExpression(this, arg.value, scope));
      return;
    }
    checkResourceIdExpression(this, expression, scope);
  }

  private checkExternDecl(statement: ExternDeclNode, scope: RsglScope): void {
    const kind = this.externDeclKind(statement);
    if (!kind) {
      this.diagnostics.push(diagnostic("rsgl.invalidExternKind", "Extern resource kind must be 'model', 'blockstate', 'item', or 'texture'.", statement.resourceKind?.range ?? statement.range));
    }
    const idArg = this.externIdArgument(statement);
    if (!idArg) {
      this.diagnostics.push(diagnostic("rsgl.missingArgument", "Missing extern argument 'id'.", statement.range));
      return;
    }
    checkResourceIdExpression(this, idArg.value, scope);
  }

  private externDeclKind(statement: ExternDeclNode): "model" | "blockstate" | "item" | "texture" | null {
    const kind = statement.resourceKind?.text;
    return kind === "model" || kind === "blockstate" || kind === "item" || kind === "texture" ? kind : null;
  }

  private externIdArgument(statement: ExternDeclNode): ExternDeclNode["args"][number] | undefined {
    return statement.args.find(arg => arg.name?.text === "id")
      ?? statement.args.filter(arg => !arg.name)[0];
  }

  private externDeclId(statement: ExternDeclNode): string | undefined {
    const arg = this.externIdArgument(statement);
    return arg ? expressionToStaticText(arg.value) : undefined;
  }

  private checkOverlayFormatExpression(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "RangeExpr") {
      this.checkExpression(expression.startExpr, scope);
      this.checkExpression(expression.endExpr, scope);
      return;
    }
    this.checkExpression(expression, scope);
  }

  private checkBody(body: CheckableBody, scope: RsglScope): void {
    if (body.kind === "ResourceBody") {
      this.checkResourceBody(body, scope);
    } else if (body.kind === "Block") {
      this.predeclareTopLevel(body.statements, scope);
      this.checkTopLevelStatements(body.statements, scope);
    } else if (body.kind === "VariantBody") {
      this.checkVariantBody(body, scope);
    } else {
      this.checkMultipartBody(body, scope);
    }
  }

  private checkResourceBody(body: ResourceBodyNode, scope: RsglScope, owner = "resource"): void {
    for (const statement of body.statements) {
      this.checkResourceStatement(statement, scope, owner);
    }
  }

  private checkResourceStatement(statement: ResourceStatementNode, scope: RsglScope, owner: string): void {
    if (statement.kind === "PropertyStmt") {
      if (owner === "equipment" && statement.name.text === "layers") {
        checkEquipmentLayerListExpression(this, statement.value, scope);
      } else if (owner === "scaling" && statement.name.text === "type") {
        checkStringEnumLikeExpression(this, statement.value, scope);
      } else {
        this.checkExpression(statement.value, scope);
      }
      validateResourceLocationLike(this, statement.value);
    } else if (statement.kind === "SectionStmt") {
      if (statement.value) {
        if (owner === "equipment" && statement.name.text === "layers") {
          checkEquipmentLayerListExpression(this, statement.value, scope);
        } else if (owner === "scaling" && statement.name.text === "type") {
          checkStringEnumLikeExpression(this, statement.value, scope);
        } else {
          this.checkExpression(statement.value, scope);
        }
      }
      if (statement.body) {
        this.checkResourceBody(statement.body, createChildScope(scope, "block"), statement.name.text);
      }
    } else if (statement.kind === "VariantsSection") {
      this.checkVariantStatements(statement.entries, scope);
    } else if (statement.kind === "MultipartSection") {
      this.checkMultipartStatements(statement.entries, scope);
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "LetDecl") {
      checkLocalLetDecl(this, statement, scope);
    } else if (statement.kind === "PackFormatsStmt") {
      if (statement.min) {
        this.checkExpression(statement.min, scope);
      }
      if (statement.max) {
        this.checkExpression(statement.max, scope);
      }
    } else if (statement.kind === "PackOverlayStmt") {
      this.checkExpression(statement.directory, scope);
      this.checkResourceBody(statement.body, createChildScope(scope, "block"), "packOverlay");
    } else if (statement.kind === "PackFilterBlockStmt") {
      if (statement.namespace) {
        this.checkExpression(statement.namespace, scope);
      }
      if (statement.path) {
        this.checkExpression(statement.path, scope);
      }
    } else if (statement.kind === "AtlasDirectoryStmt") {
      if (statement.source) {
        this.checkExpression(statement.source, scope);
      }
      if (statement.prefix) {
        this.checkExpression(statement.prefix, scope);
      }
    } else if (statement.kind === "AtlasFilterStmt") {
      if (statement.namespace) {
        this.checkExpression(statement.namespace, scope);
      }
      if (statement.path) {
        this.checkExpression(statement.path, scope);
      }
    } else if (statement.kind === "AtlasPalettedPermutationsStmt") {
      this.checkResourceBody(statement.body, createChildScope(scope, "block"), "atlasPalettedPermutations");
    } else if (statement.kind === "EquipmentLayerStmt") {
      checkEquipmentLayerNameExpression(this, statement.layer, scope);
      if (statement.texture) {
        this.checkExpression(statement.texture, scope);
      }
      if (statement.dyeable) {
        this.checkExpression(statement.dyeable, scope);
      }
      if (statement.color) {
        this.checkExpression(statement.color, scope);
      }
      if (statement.usePlayerTexture) {
        this.checkExpression(statement.usePlayerTexture, scope);
      }
    } else if (statement.kind === "ItemRangeStmt") {
      this.checkExpression(statement.property, scope);
      statement.options.forEach(option => this.checkExpression(option.value, scope));
      if (statement.frames) {
        this.checkExpression(statement.frames.frames, scope);
        const frameScope = createChildScope(scope, "block");
        this.defineIdentifier(frameScope, this.syntheticIdentifier("index", statement.frames.range), "variable", numberType, statement.frames);
        this.defineIdentifier(frameScope, this.syntheticIdentifier("frame", statement.frames.range), "variable", anyType, statement.frames);
        this.checkExpression(statement.frames.model, frameScope);
      }
      if (statement.fallback) {
        this.checkExpression(statement.fallback, scope);
      }
    } else if (statement.kind === "ItemSelectStmt") {
      this.checkExpression(statement.property, scope);
      statement.options.forEach(option => this.checkExpression(option.value, scope));
      statement.cases.forEach(item => {
        this.checkExpression(item.when, scope);
        this.checkExpression(item.model, scope);
      });
      if (statement.fallback) {
        this.checkExpression(statement.fallback, scope);
      }
    } else if (statement.kind === "ItemConditionStmt") {
      this.checkExpression(statement.property, scope);
      statement.options.forEach(option => this.checkExpression(option.value, scope));
      if (statement.onTrue) {
        this.checkExpression(statement.onTrue, scope);
      }
      if (statement.onFalse) {
        this.checkExpression(statement.onFalse, scope);
      }
    } else if (statement.kind === "ItemCompositeStmt") {
      statement.models.forEach(model => this.checkExpression(model, scope));
    } else if (statement.kind === "ItemSpecialStmt") {
      this.checkExpression(statement.base, scope);
      this.checkExpression(statement.model, scope);
    } else if (statement.kind === "ForStmt") {
      this.checkForStatement(statement, scope);
    } else if (statement.kind === "IfStmt") {
      this.checkExpression(statement.condition, scope);
      this.checkBody(statement.thenBody, createChildScope(scope, "block"));
      if (statement.elseBody) {
        this.checkBody(statement.elseBody, createChildScope(scope, "block"));
      }
    } else if (statement.kind === "RawJsonStmt" || statement.kind === "OverrideStmt" || statement.kind === "AppendStmt") {
      this.checkExpression(statement.value, scope);
    }
  }

  private checkForStatement(statement: ForStmtNode, scope: RsglScope): void {
    const loopScope = createChildScope(scope, "loop");
    const seen = new Set<string>();
    const forDimensions = statement.dimensions.length ? statement.dimensions : [{
      kind: "ForDimension" as const,
      bindings: statement.bindings,
      iterable: statement.iterable,
      range: statement.range,
      fullRange: statement.fullRange
    }];
    for (const dimension of forDimensions) {
      this.checkForIterableExpression(dimension.iterable, loopScope);
      const finiteDomain = dimension.bindings.length === 1 ? finiteStringDomain(dimension.iterable, loopScope) : null;
      for (const binding of dimension.bindings) {
        if (seen.has(binding.text)) {
          this.diagnostics.push(diagnostic("rsgl.duplicateLoopBinding", `Duplicate loop binding '${binding.text}'.`, binding.range));
        }
        seen.add(binding.text);
        this.defineIdentifier(loopScope, binding, "variable", anyType, binding);
        if (finiteDomain) {
          const symbol = lookup(loopScope, binding.text);
          if (symbol) {
            symbol.finiteDomain = finiteDomain;
          }
        }
      }
    }
    this.checkBody(statement.body, loopScope);
  }

  private checkForIterableExpression(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind !== "ListExpr") {
      return this.checkExpression(expression, scope);
    }
    const elementTypes = expression.elements.map(element => this.checkForIterableListElement(element, scope));
    return { kind: "List", elementType: elementTypes[0] ?? unknownType };
  }

  private checkForIterableListElement(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
      return stringType;
    }
    return this.checkExpression(expression, scope);
  }

  private checkVariantBody(body: VariantBodyNode, scope: RsglScope): void {
    this.checkVariantStatements(body.statements, scope);
  }

  private checkVariantStatements(statements: VariantSectionStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      this.checkVariantStatement(statement, scope);
    }
  }

  private checkVariantStatement(statement: VariantSectionStatementNode, scope: RsglScope): void {
    if (statement.kind === "VariantEntry") {
      this.checkExpression(statement.state, scope);
      this.checkExpression(statement.value, scope);
    } else if (statement.kind === "LetDecl") {
      checkLocalLetDecl(this, statement, scope);
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "ForStmt") {
      this.checkForStatement(statement, scope);
    } else if (statement.kind === "IfStmt") {
      this.checkExpression(statement.condition, scope);
      this.checkBody(statement.thenBody, createChildScope(scope, "block"));
      if (statement.elseBody) {
        this.checkBody(statement.elseBody, createChildScope(scope, "block"));
      }
    }
  }

  private checkMultipartBody(body: MultipartBodyNode, scope: RsglScope): void {
    this.checkMultipartStatements(body.statements, scope);
  }

  private checkMultipartStatements(statements: MultipartSectionStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      this.checkMultipartStatement(statement, scope);
    }
  }

  private checkMultipartStatement(statement: MultipartSectionStatementNode, scope: RsglScope): void {
    if (statement.kind === "MultipartEntry") {
      if (statement.when) {
        this.checkExpression(statement.when, scope);
      }
      this.checkExpression(statement.apply, scope);
    } else if (statement.kind === "LetDecl") {
      checkLocalLetDecl(this, statement, scope);
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "ForStmt") {
      this.checkForStatement(statement, scope);
    } else if (statement.kind === "IfStmt") {
      this.checkExpression(statement.condition, scope);
      this.checkBody(statement.thenBody, createChildScope(scope, "block"));
      if (statement.elseBody) {
        this.checkBody(statement.elseBody, createChildScope(scope, "block"));
      }
    }
  }

  private checkExpression(expression: ExprNode, scope: RsglScope): RsglType {
    return checkExpression(this, expression, scope);
  }

  private syntheticIdentifier(text: string, range: { start: number; end: number }): IdentifierNode {
    return {
      kind: "Identifier",
      text,
      range,
      fullRange: range
    };
  }

  private recordImport(statement: Extract<TopLevelStatementNode, { kind: "ImportDecl" }>, scope: RsglScope): void {
    if (!statement.source) {
      return;
    }

    const source = statement.source.value;
    const resolvedFileName = this.options.resolver?.resolveImport(this.fileName, source) ?? undefined;
    const record: RsglImportRecord = {
      source,
      node: statement,
      defaultName: statement.defaultName?.text,
      importAll: !statement.defaultName && statement.namedImports.length === 0,
      namedImports: statement.namedImports.map(item => ({
        imported: item.imported.text,
        local: item.local.text,
        range: item.range
      })),
      resolvedFileName
    };
    this.imports.push(record);

    if (statement.defaultName) {
      this.defineIdentifier(scope, statement.defaultName, "import", { kind: "Object" }, statement);
    }
    for (const specifier of statement.namedImports) {
      this.defineIdentifier(scope, specifier.local, "import", anyType, specifier);
    }
  }

  private recordExport(statement: Extract<TopLevelStatementNode, { kind: "ExportDecl" }>): void {
    const source = statement.source?.value;
    const resolvedFileName = source
      ? this.options.resolver?.resolveImport(this.fileName, source) ?? undefined
      : undefined;
    this.exports.push({
      source,
      node: statement,
      exportAll: statement.exportAll,
      specifiers: statement.specifiers.map(item => ({
        local: item.local.text,
        exported: item.exported.text,
        range: item.range
      })),
      resolvedFileName
    });
  }

  private defineTemplate(scope: RsglScope, statement: TemplateDeclNode): void {
    this.defineCallable(scope, statement, "template");
  }

  private defineCallable(scope: RsglScope, statement: TemplateDeclNode, kind: "template"): void {
    const name = identifierName(statement.name);
    if (!name) {
      return;
    }
    this.define(scope, {
      name,
      kind,
      type: { kind: "Function" },
      node: statement,
      range: statement.name?.range,
      signature: {
        parameters: statement.parameters
          .filter(parameter => parameter.name)
          .map(parameter => ({
            name: parameter.name!.text,
            type: typeFromAnnotation(parameter.typeAnnotation),
            optional: Boolean(parameter.defaultValue),
            node: parameter
          })),
        returnType: jsonType
      }
    });
  }

  private defineResource(scope: RsglScope, statement: ResourceDeclNode, id: string | undefined): void {
    if (!id) {
      return;
    }
    this.define(scope, {
      name: `${statement.resourceKind}:${id}`,
      kind: "resource",
      type: resourceIdType,
      node: statement,
      range: statement.id?.range
    });
  }

  private define(scope: RsglScope, symbol: RsglSymbol): void {
    const existing = scope.symbols.get(symbol.name);
    if (existing && existing.kind !== "builtin" && symbol.kind !== "builtin") {
      this.diagnostics.push(diagnostic("rsgl.duplicateSymbol", `Duplicate RSGL symbol '${symbol.name}'.`, symbol.range ?? symbol.node?.range ?? { start: 0, end: 1 }));
      return;
    }
    scope.symbols.set(symbol.name, symbol);
    if (symbol.kind !== "builtin") {
      this.symbols.push(symbol);
    }
  }
}

function expressionToStaticText(expression: ExprNode): string | undefined {
  if (expression.kind === "IdentifierExpr") {
    return expression.name.text;
  }
  if (expression.kind === "ResourceLocationExpr") {
    return expression.value;
  }
  if (expression.kind === "StringLiteral") {
    return expression.value;
  }
  return undefined;
}
