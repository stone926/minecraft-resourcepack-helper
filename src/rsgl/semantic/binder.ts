import * as path from "node:path";
import {
  ArgumentNode,
  BlockNode,
  CallExprNode,
  ExprNode,
  FragmentDeclNode,
  IdentifierNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  ObjectExprNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglDiagnostic,
  RsglModule,
  RsglNode,
  SugarDeclNode,
  TemplateDeclNode,
  TopLevelStatementNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "../parser";
import { bindRsglArguments } from "../arguments";
import { createBuiltinSymbols } from "./builtins";
import { createRsglExportMaps } from "./exportResolution";
import { validateResolvedImportCalls } from "./importValidation";
import { formatType, isAssignable } from "./typeRelations";
import {
  anyType,
  booleanType,
  identifierName,
  inferLiteralType,
  jsonType,
  numberType,
  resourceIdType,
  RsglBindOptions,
  RsglExportRecord,
  RsglFileDiagnostic,
  RsglImportGraph,
  RsglImportRecord,
  RsglOutputResourcePreview,
  RsglProgram,
  RsglReferenceRecord,
  RsglScope,
  RsglSemanticModel,
  RsglSignature,
  RsglSourceFile,
  RsglSymbol,
  RsglType,
  stringType,
  typeFromAnnotation,
  unknownType
} from "./types";

const resourceLocationPattern = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const resourcePathPattern = /^[a-z0-9_./-]+$/;

type CheckableBody = ResourceBodyNode | BlockNode | VariantBodyNode | MultipartBodyNode;

export function bindRsglModule(module: RsglModule, options: RsglBindOptions = {}): RsglSemanticModel {
  const binder = new RsglBinder(module, options.fileName ?? "<anonymous>", options);
  return binder.bind();
}

export function bindRsglProgram(files: RsglSourceFile[], options: RsglBindOptions = {}): RsglProgram {
  const resolver = options.resolver ?? createDefaultResolver(files);
  const models = files.map(file => bindRsglModule(file.module, { ...options, fileName: file.fileName, resolver }));
  const importGraph = buildImportGraph(files, models, resolver);
  const exportMaps = createRsglExportMaps(models, importGraph);
  const importDiagnostics = resolveProgramImports(models, importGraph, exportMaps.maps);
  const importedCallDiagnostics = models.flatMap(model => withFileName(model.fileName, validateResolvedImportCalls(model)));
  const fileDiagnostics: RsglFileDiagnostic[] = [
    ...models.flatMap(model => withFileName(model.fileName, model.diagnostics)),
    ...exportMaps.fileDiagnostics,
    ...importDiagnostics,
    ...importedCallDiagnostics,
    ...importGraph.missing.map(missing => fileDiagnostic(
      missing.from,
      "rsgl.missingImport",
      `RSGL import not found: ${missing.source}`,
      missing.range
    )),
    ...importCycleDiagnostics(importGraph)
  ];
  const diagnostics = fileDiagnostics.map(toDiagnostic);

  return { files, models, importGraph, diagnostics, fileDiagnostics };
}

class RsglBinder {
  private readonly diagnostics: RsglDiagnostic[] = [];
  private readonly symbols: RsglSymbol[] = [];
  private readonly imports: RsglImportRecord[] = [];
  private readonly exports: RsglExportRecord[] = [];
  private readonly references: RsglReferenceRecord[] = [];
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

  private predeclareTopLevel(statements: TopLevelStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      if (statement.kind === "ImportDecl") {
        this.recordImport(statement, scope);
      } else if (statement.kind === "ExportDecl") {
        this.recordExport(statement);
      } else if (statement.kind === "LetDecl") {
        this.defineIdentifier(scope, statement.name, "variable", typeFromAnnotation(statement.typeAnnotation), statement);
      } else if (statement.kind === "TableDecl") {
        this.defineIdentifier(scope, statement.name, "table", jsonType, statement);
      } else if (statement.kind === "TemplateDecl") {
        this.defineTemplate(scope, statement);
      } else if (statement.kind === "FragmentDecl") {
        this.defineFragment(scope, statement);
      } else if (statement.kind === "NamespaceDecl") {
        this.namespace = expressionToStaticText(statement.name) ?? this.namespace;
      } else if (statement.kind === "ResourceDecl") {
        const id = statement.id ? expressionToStaticText(statement.id) : undefined;
        this.outputResources.push({ kind: statement.resourceKind, id, node: statement });
        this.defineResource(scope, statement, id);
      } else if (statement.kind === "SugarDecl") {
        this.outputResources.push({ kind: "sugar", id: statement.id ? expressionToStaticText(statement.id) : undefined, node: statement });
      }
    }
  }

  private checkTopLevelStatements(statements: TopLevelStatementNode[], scope: RsglScope): void {
    for (const statement of statements) {
      if (statement.kind === "LetDecl") {
        const actualType = this.checkExpression(statement.value, scope);
        const expectedType = typeFromAnnotation(statement.typeAnnotation);
        this.checkAssignable(expectedType, actualType, statement.value);
      } else if (statement.kind === "TableDecl") {
        this.checkObject(statement.body, scope);
      } else if (statement.kind === "TemplateDecl") {
        this.checkTemplate(statement, scope);
      } else if (statement.kind === "FragmentDecl") {
        this.checkFragment(statement, scope);
      } else if (statement.kind === "ResourceDecl") {
        this.checkResourceDecl(statement, scope);
      } else if (statement.kind === "SugarDecl") {
        this.checkSugarDecl(statement, scope);
      } else if (statement.kind === "UseDecl") {
        this.checkExpression(statement.expression, scope);
      } else if (statement.kind === "ForStmt") {
        this.checkForStatement(statement.bindings, statement.iterable, statement.body, scope);
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
    this.checkBody(statement.body, scope);
  }

  private checkFragment(statement: FragmentDeclNode, parentScope: RsglScope): void {
    const scope = createChildScope(parentScope, "template");
    this.checkCallableParameters(statement.parameters, scope);
    this.checkResourceBody(statement.body, scope);
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
        this.checkAssignable(expectedType, actualType, parameter.defaultValue);
      }
    }
  }

  private checkResourceDecl(statement: ResourceDeclNode, scope: RsglScope): void {
    if (statement.id) {
      this.checkResourceIdExpression(statement.id, scope);
      this.validateResourceLocationLike(statement.id);
    }
    this.checkResourceBody(statement.body, createChildScope(scope, "block"));
  }

  private checkOverlayFormatExpression(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "RangeExpr") {
      this.checkExpression(expression.startExpr, scope);
      this.checkExpression(expression.endExpr, scope);
      return;
    }
    this.checkExpression(expression, scope);
  }

  private checkSugarDecl(statement: SugarDeclNode, scope: RsglScope): void {
    if (statement.id) {
      this.checkResourceIdExpression(statement.id, scope);
      this.validateResourceLocationLike(statement.id);
    }
    for (const entry of statement.entries) {
      this.checkResourceIdExpression(entry.id, scope);
      if (entry.target) {
        this.checkResourceIdExpression(entry.target, scope);
      }
    }
    for (const option of statement.options) {
      if (option.value) {
        this.checkExpression(option.value, scope);
      }
    }
    if (statement.body) {
      this.checkResourceBody(statement.body, createChildScope(scope, "block"));
    }
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

  private checkResourceBody(body: ResourceBodyNode, scope: RsglScope): void {
    for (const statement of body.statements) {
      this.checkResourceStatement(statement, scope);
    }
  }

  private checkResourceStatement(statement: ResourceStatementNode, scope: RsglScope): void {
    if (statement.kind === "PropertyStmt") {
      this.checkExpression(statement.value, scope);
      this.validateResourceLocationLike(statement.value);
    } else if (statement.kind === "SectionStmt") {
      if (statement.value) {
        this.checkExpression(statement.value, scope);
      }
      if (statement.body) {
        this.checkResourceBody(statement.body, createChildScope(scope, "block"));
      }
    } else if (statement.kind === "VariantsSection") {
      this.checkVariantStatements(statement.entries, scope);
    } else if (statement.kind === "MultipartSection") {
      this.checkMultipartStatements(statement.entries, scope);
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "ItemRangeStmt") {
      this.checkExpression(statement.property, scope);
      statement.options.forEach(option => this.checkExpression(option.value, scope));
      if (statement.frames) {
        this.checkExpression(statement.frames.frames, scope);
        this.checkExpression(statement.frames.model, scope);
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
      this.checkForStatement(statement.bindings, statement.iterable, statement.body, scope);
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

  private checkForStatement(
    bindings: IdentifierNode[],
    iterable: ExprNode,
    body: CheckableBody,
    scope: RsglScope
  ): void {
    this.checkExpression(iterable, scope);
    const loopScope = createChildScope(scope, "loop");
    for (const binding of bindings) {
      this.defineIdentifier(loopScope, binding, "variable", anyType, binding);
    }
    this.checkBody(body, loopScope);
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
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "ForStmt") {
      this.checkForStatement(statement.bindings, statement.iterable, statement.body, scope);
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
    } else if (statement.kind === "UseDecl") {
      this.checkExpression(statement.expression, scope);
    } else if (statement.kind === "ForStmt") {
      this.checkForStatement(statement.bindings, statement.iterable, statement.body, scope);
    } else if (statement.kind === "IfStmt") {
      this.checkExpression(statement.condition, scope);
      this.checkBody(statement.thenBody, createChildScope(scope, "block"));
      if (statement.elseBody) {
        this.checkBody(statement.elseBody, createChildScope(scope, "block"));
      }
    }
  }

  private checkExpression(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind === "IdentifierExpr") {
      const symbol = lookup(scope, expression.name.text);
      this.references.push({ name: expression.name.text, range: expression.range, symbol });
      if (!symbol) {
        this.diagnostics.push(diagnostic("rsgl.undefinedSymbol", `Undefined RSGL symbol '${expression.name.text}'.`, expression.range));
        return unknownType;
      }
      return symbol.type;
    }
    if (expression.kind === "ResourceLocationExpr") {
      this.validateResourceLocationValue(expression.value, expression.range);
      return resourceIdType;
    }
    if (expression.kind === "ListExpr") {
      const elementTypes = expression.elements.map(element => this.checkExpression(element, scope));
      return { kind: "List", elementType: elementTypes[0] ?? unknownType };
    }
    if (expression.kind === "ObjectExpr") {
      return this.checkObject(expression, scope);
    }
    if (expression.kind === "StateKeySugar") {
      for (const entry of expression.entries) {
        this.checkExpression(entry.value, scope);
      }
      return jsonType;
    }
    if (expression.kind === "ModelApplySugar") {
      this.checkExpression(expression.model, scope);
      for (const property of expression.properties) {
        this.checkExpression(property.value, scope);
      }
      return jsonType;
    }
    if (expression.kind === "RandomApply") {
      for (const entry of expression.entries) {
        this.checkExpression(entry, scope);
      }
      return jsonType;
    }
    if (expression.kind === "CallExpr") {
      return this.checkCallExpression(expression, scope);
    }
    if (expression.kind === "MemberExpr") {
      this.checkExpression(expression.object, scope);
      return anyType;
    }
    if (expression.kind === "IndexExpr") {
      this.checkExpression(expression.object, scope);
      this.checkExpression(expression.index, scope);
      return anyType;
    }
    if (expression.kind === "UnaryExpr") {
      this.checkExpression(expression.operand, scope);
      return expression.operator === "!" ? booleanType : numberType;
    }
    if (expression.kind === "BinaryExpr") {
      this.checkExpression(expression.left, scope);
      this.checkExpression(expression.right, scope);
      return expression.operator === "&&" || expression.operator === "||" || expression.operator.includes("=") ? booleanType : numberType;
    }
    if (expression.kind === "RangeExpr") {
      const startType = this.checkExpression(expression.startExpr, scope);
      const endType = this.checkExpression(expression.endExpr, scope);
      this.checkAssignable(numberType, startType, expression.startExpr);
      this.checkAssignable(numberType, endType, expression.endExpr);
      return { kind: "Range", elementType: numberType };
    }
    if (expression.kind === "ConditionalExpr") {
      this.checkExpression(expression.condition, scope);
      const trueType = this.checkExpression(expression.whenTrue, scope);
      const falseType = this.checkExpression(expression.whenFalse, scope);
      return isAssignable(trueType, falseType) ? trueType : anyType;
    }
    if (expression.kind === "MatchExpr") {
      this.checkExpression(expression.expression, scope);
      for (const arm of expression.arms) {
        arm.patterns
          .filter(pattern => !isWildcardPattern(pattern))
          .forEach(pattern => this.checkExpression(pattern, scope));
        this.checkExpression(arm.value, scope);
      }
      return anyType;
    }
    if (expression.kind === "TemplateStringExpr") {
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          this.checkExpression(part.expression, scope);
        }
      }
      return stringType;
    }
    return inferLiteralType(expression);
  }

  private checkResourceIdExpression(expression: ExprNode, scope: RsglScope): RsglType {
    if (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text)) {
      return resourceIdType;
    }
    return this.checkExpression(expression, scope);
  }

  private checkObject(expression: ObjectExprNode, scope: RsglScope): RsglType {
    const properties = new Map<string, RsglType>();
    for (const property of expression.properties) {
      const key = objectKeyName(property);
      const valueType = this.checkExpression(property.value, scope);
      if (key) {
        properties.set(key, valueType);
      }
      if (property.key.kind === "DynamicKey") {
        this.checkExpression(property.key.expression, scope);
      }
    }
    return { kind: "Object", properties };
  }

  private checkCallExpression(expression: CallExprNode, scope: RsglScope): RsglType {
    const { callee, args } = expression;
    const calleeType = this.checkExpression(callee, scope);

    if (callee.kind !== "IdentifierExpr") {
      for (const arg of args) {
        this.checkExpression(arg.value, scope);
      }
      return calleeType.kind === "Function" ? anyType : unknownType;
    }

    const symbol = lookup(scope, callee.name.text);
    if (!symbol?.signature) {
      if (symbol?.kind === "import") {
        return anyType;
      }
      for (const arg of args) {
        this.checkExpression(arg.value, scope);
      }
      return symbol?.type ?? unknownType;
    }

    this.checkArguments(symbol.signature, args, scope, expression.range);
    return symbol.signature.returnType;
  }

  private checkArguments(signature: RsglSignature, args: ArgumentNode[], scope: RsglScope, callRange: { start: number; end: number }): void {
    const binding = bindRsglArguments(signature.parameters, args, { callRange });
    this.diagnostics.push(...binding.diagnostics);
    const checkedArgs = new Set<ArgumentNode>();

    for (const { parameter, arg } of binding.assignments) {
      checkedArgs.add(arg);
      const actualType = parameter.type.kind === "ResourceId" || parameter.type.kind === "ModelId" || parameter.type.kind === "TextureId"
        ? this.checkResourceIdExpression(arg.value, scope)
        : this.checkExpression(arg.value, scope);
      this.checkAssignable(parameter.type, actualType.kind === "Unknown" ? anyType : actualType, arg.value);
    }
    for (const arg of binding.unmatchedArgs) {
      if (!checkedArgs.has(arg)) {
        this.checkExpression(arg.value, scope);
      }
    }
  }

  private checkAssignable(expected: RsglType, actual: RsglType, node: RsglNode): void {
    if (!isAssignable(expected, actual)) {
      this.diagnostics.push(diagnostic(
        "rsgl.typeMismatch",
        `Expected ${formatType(expected)}, got ${formatType(actual)}.`,
        node.range
      ));
    }
  }

  private validateResourceLocationLike(expression: ExprNode): void {
    if (expression.kind === "ResourceLocationExpr") {
      this.validateResourceLocationValue(expression.value, expression.range);
    }
  }

  private validateResourceLocationValue(value: string, range: { start: number; end: number }): void {
    if (value.includes(":")) {
      if (!resourceLocationPattern.test(value)) {
        this.diagnostics.push(diagnostic("rsgl.invalidResourceLocation", `Invalid resource location '${value}'.`, range));
      }
    } else if (!resourcePathPattern.test(value)) {
      this.diagnostics.push(diagnostic("rsgl.invalidResourcePath", `Invalid resource path '${value}'.`, range));
    }
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

  private defineFragment(scope: RsglScope, statement: FragmentDeclNode): void {
    this.defineCallable(scope, statement, "fragment");
  }

  private defineCallable(scope: RsglScope, statement: TemplateDeclNode | FragmentDeclNode, kind: "template" | "fragment"): void {
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

  private defineIdentifier(
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

  private define(scope: RsglScope, symbol: RsglSymbol): void {
    if (scope.symbols.has(symbol.name) && symbol.kind !== "builtin") {
      this.diagnostics.push(diagnostic("rsgl.duplicateSymbol", `Duplicate RSGL symbol '${symbol.name}'.`, symbol.range ?? symbol.node?.range ?? { start: 0, end: 1 }));
      return;
    }
    scope.symbols.set(symbol.name, symbol);
    if (symbol.kind !== "builtin") {
      this.symbols.push(symbol);
    }
  }
}

function resolveProgramImports(
  models: RsglSemanticModel[],
  importGraph: RsglImportGraph,
  exportMaps: Map<string, Map<string, RsglSymbol>>
): RsglFileDiagnostic[] {
  const diagnostics: RsglFileDiagnostic[] = [];
  const modelsByFile = new Map(models.map(model => [normalizeFileName(model.fileName), model]));

  for (const edge of importGraph.edges) {
    const sourceModel = modelsByFile.get(edge.from);
    const targetModel = modelsByFile.get(edge.to);
    if (!sourceModel || !targetModel) {
      continue;
    }

    const record = sourceModel.imports.find(item =>
      item.source === edge.source &&
      normalizeFileName(item.resolvedFileName ?? edge.to) === edge.to
    );
    if (!record) {
      continue;
    }

    for (const item of record.namedImports) {
      const exported = exportMaps.get(normalizeFileName(targetModel.fileName))?.get(item.imported);
      const localSymbol = sourceModel.scope.symbols.get(item.local);
      if (!exported) {
        diagnostics.push(fileDiagnostic(
          sourceModel.fileName,
          "rsgl.missingImportedSymbol",
          `RSGL module '${record.source}' does not export '${item.imported}'.`,
          item.range
        ));
        continue;
      }
      if (localSymbol) {
        localSymbol.type = exported.type;
        localSymbol.signature = exported.signature;
        localSymbol.node = exported.node;
      }
    }
  }

  return diagnostics;
}

function createScope(kind: RsglScope["kind"], parent?: RsglScope): RsglScope {
  return { kind, parent, symbols: new Map() };
}

function createChildScope(parent: RsglScope, kind: RsglScope["kind"]): RsglScope {
  return createScope(kind, parent);
}

function lookup(scope: RsglScope, name: string): RsglSymbol | undefined {
  let current: RsglScope | undefined = scope;
  while (current) {
    const symbol = current.symbols.get(name);
    if (symbol) {
      return symbol;
    }
    current = current.parent;
  }
  return undefined;
}

function objectKeyName(property: ObjectPropertyNode): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  return null;
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

function diagnostic(code: string, message: string, range: { start: number; end: number }, severity: RsglDiagnostic["severity"] = "error"): RsglDiagnostic {
  return { code, message, range, severity };
}

function fileDiagnostic(fileName: string, code: string, message: string, range: { start: number; end: number }, severity: RsglDiagnostic["severity"] = "error"): RsglFileDiagnostic {
  return { fileName, code, message, range, severity };
}

function withFileName(fileName: string, diagnostics: RsglDiagnostic[]): RsglFileDiagnostic[] {
  return diagnostics.map(item => ({ ...item, fileName }));
}

function toDiagnostic(diagnostic: RsglFileDiagnostic): RsglDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity
  };
}

function isWildcardPattern(expression: ExprNode): boolean {
  return expression.kind === "IdentifierExpr" && expression.name.text === "_";
}

function importCycleDiagnostics(importGraph: RsglImportGraph): RsglFileDiagnostic[] {
  return importGraph.cycles.flatMap(cycle => cycle.map((fileName, index) => {
    const nextFileName = cycle[(index + 1) % cycle.length];
    const edge = importGraph.edges.find(item => item.from === fileName && item.to === nextFileName);
    return fileDiagnostic(
      fileName,
      "rsgl.importCycle",
      `RSGL import cycle includes ${fileName}.`,
      edge?.range ?? { start: 0, end: 1 }
    );
  }));
}

function createDefaultResolver(files: RsglSourceFile[]) {
  const fileNames = new Set(files.map(file => normalizeFileName(file.fileName)));
  return {
    resolveImport(fromFileName: string, source: string): string | null {
      if (!source.startsWith(".")) {
        return null;
      }
      const resolved = normalizeFileName(path.resolve(path.dirname(fromFileName), source));
      return fileNames.has(resolved) ? resolved : null;
    }
  };
}

function buildImportGraph(
  files: RsglSourceFile[],
  models: RsglSemanticModel[],
  resolver: { resolveImport(fromFileName: string, source: string): string | null }
): RsglImportGraph {
  const normalizedFiles = files.map(file => normalizeFileName(file.fileName));
  const edges: RsglImportGraph["edges"] = [];
  const missing: RsglImportGraph["missing"] = [];

  for (const model of models) {
    for (const record of model.imports) {
      const resolved = record.resolvedFileName ?? resolver.resolveImport(model.fileName, record.source);
      if (resolved) {
        edges.push({
          from: normalizeFileName(model.fileName),
          to: normalizeFileName(resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeFileName(model.fileName),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      }
    }
    for (const record of model.exports) {
      if (!record.source) {
        continue;
      }
      const resolved = record.resolvedFileName ?? resolver.resolveImport(model.fileName, record.source);
      if (resolved) {
        edges.push({
          from: normalizeFileName(model.fileName),
          to: normalizeFileName(resolved),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      } else {
        missing.push({
          from: normalizeFileName(model.fileName),
          source: record.source,
          range: record.node.source?.range ?? record.node.range
        });
      }
    }
  }

  return {
    files: normalizedFiles,
    edges,
    cycles: findCycles(normalizedFiles, edges),
    missing
  };
}

function findCycles(files: string[], edges: RsglImportGraph["edges"]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const file of files) {
    adjacency.set(file, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      if (start >= 0) {
        cycles.push(stack.slice(start));
      }
      return;
    }
    if (visited.has(file)) {
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const next of adjacency.get(file) ?? []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  files.forEach(visit);
  return cycles;
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
