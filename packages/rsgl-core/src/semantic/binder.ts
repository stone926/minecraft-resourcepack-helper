import {
  ExprNode,
  ExternDeclNode,
  IdentifierNode,
  ResourceDeclNode,
  RsglDiagnostic,
  RsglModule,
  RsglNode,
  TemplateDeclNode,
  TopLevelStatementNode
} from "../parser";
import { externResourceKindDescription, getExternResourceKind } from "../resourceKinds";
import { createBuiltinSymbols } from "./builtins";
import { diagnostic } from "./diagnostics";
import { finiteStringDomain } from "./domainChecks";
import {
  checkAssignable,
  checkExpression,
  checkObject,
  checkResourceIdExpression,
  RsglExpressionCheckContext,
  validateResourceLocationLike
} from "./expressionChecker";
import { RsglResourceBodyChecker } from "./resourceBodyChecker";
import { createChildScope, createScope, lookup } from "./scopes";
import {
  anyType,
  identifierName,
  jsonType,
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
  typeFromAnnotation
} from "./types";

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
  private readonly importCallScopes = new Map<ExprNode, RsglScope>();
  private readonly globalScope: RsglScope = createScope("global");
  private readonly bodyChecker: RsglResourceBodyChecker;
  private namespace: string | undefined;

  public constructor(
    private readonly module: RsglModule,
    private readonly fileName: string,
    private readonly options: RsglBindOptions
  ) {
    this.bodyChecker = new RsglResourceBodyChecker(this, (statements, scope) => {
      this.predeclareTopLevel(statements, scope);
      this.checkTopLevelStatements(statements, scope);
    });
  }

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
      namespace: this.namespace,
      importCallScopes: this.importCallScopes
    };
  }

  public recordImportCallScope(expression: ExprNode, scope: RsglScope): void {
    this.importCallScopes.set(expression, snapshotScope(scope));
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
        if (symbol && symbol.node === statement) {
          if (!statement.typeAnnotation) {
            symbol.type = actualType;
          }
          symbol.finiteDomain = finiteStringDomain(statement.value, scope) ?? undefined;
        }
      } else if (statement.kind === "TableDecl") {
        checkObject(this, statement.body, scope);
      } else if (statement.kind === "TemplateDecl") {
        this.checkTemplate(statement, scope);
      } else if (statement.kind === "ExternDecl") {
        this.checkExternDecl(statement);
      } else if (statement.kind === "ResourceDecl") {
        this.checkResourceDecl(statement, scope);
      } else if (statement.kind === "UseDecl") {
        this.checkExpression(statement.expression, scope);
      } else if (statement.kind === "ForStmt") {
        this.bodyChecker.checkForStatement(statement, scope);
      } else if (statement.kind === "IfStmt") {
        this.checkExpression(statement.condition, scope);
        this.bodyChecker.checkBody(statement.thenBody, createChildScope(scope, "block"));
        if (statement.elseBody) {
          this.bodyChecker.checkBody(statement.elseBody, createChildScope(scope, "block"));
        }
      } else if (statement.kind === "TargetDecl") {
        this.checkExpression(statement.value, scope);
      } else if (statement.kind === "OverlayDecl") {
        this.checkExpression(statement.directory, scope);
        if (statement.formatRange) {
          this.checkOverlayFormatExpression(statement.formatRange, scope);
        }
        this.bodyChecker.checkBody(statement.body, createChildScope(scope, "block"));
      }
    }
  }

  private checkTemplate(statement: TemplateDeclNode, parentScope: RsglScope): void {
    const scope = createChildScope(parentScope, "template");
    this.checkCallableParameters(statement.parameters, scope);
    if (statement.body.kind === "ResourceBody") {
      this.bodyChecker.checkResourceBody(statement.body, scope);
    } else {
      this.bodyChecker.checkBody(statement.body, scope);
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
    this.bodyChecker.checkResourceBody(statement.body, createChildScope(scope, "block"), statement.resourceKind);
  }

  private checkModelImpl(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "CallExpr") {
      checkResourceIdExpression(this, expression.callee, scope);
      expression.args.forEach(arg => checkResourceIdExpression(this, arg.value, scope));
      return;
    }
    checkResourceIdExpression(this, expression, scope);
  }

  private checkExternDecl(statement: ExternDeclNode): void {
    const kind = this.externDeclKind(statement);
    if (!kind) {
      this.diagnostics.push(diagnostic("rsgl.invalidExternKind", `Extern resource kind must be ${externResourceKindDescription}.`, statement.resourceKind?.range ?? statement.range));
    }
  }

  private externDeclKind(statement: ExternDeclNode) {
    return getExternResourceKind(statement.resourceKind?.text);
  }

  private checkOverlayFormatExpression(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "RangeExpr") {
      this.checkExpression(expression.startExpr, scope);
      this.checkExpression(expression.endExpr, scope);
      return;
    }
    this.checkExpression(expression, scope);
  }

  private checkExpression(expression: ExprNode, scope: RsglScope): RsglType {
    return checkExpression(this, expression, scope);
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

/**
 * Freezes the scope chain as the call site sees it. Local scopes (resource
 * bodies have no predeclare pass) keep accreting symbols after the call is
 * bound, so a live reference would let post-resolution validation accept
 * forward references the bind-time check rejects. The complete global scope is
 * shared as-is.
 */
function snapshotScope(scope: RsglScope): RsglScope {
  if (scope.kind === "global") {
    return scope;
  }
  return {
    kind: scope.kind,
    parent: scope.parent ? snapshotScope(scope.parent) : undefined,
    symbols: new Map(scope.symbols)
  };
}
