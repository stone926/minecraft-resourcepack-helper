import {
  BlockstateModelSpecNode,
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
import {
  externResourceKindDescription,
  getExternResourceKind,
  getRsglResourceKindDescriptor
} from "../resourceKinds";
import { walkRsglExpression } from "../parser/astTraversal";
import { createBuiltinSymbols } from "./builtins";
import { diagnostic } from "./diagnostics";
import { finiteStringDomain } from "./domainChecks";
import { mergeResolvedExpectedTypeFact } from "./expectedTypeFacts";
import {
  applyLambdaValueDiagnostics,
  exportedLambdaAnnotationDiagnostics
} from "./lambdaAnalysis";
import { lambdaSignature } from "./lambdaTyping";
import {
  checkAssignable,
  checkBlockstatePredicate,
  checkCompileTimeCondition,
  checkExpression,
  checkExpressionForExpectedType,
  checkObject,
  checkResourceIdExpression,
  checkTemplateUseExpression,
  validateResourceLocationLike
} from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { RsglResourceBodyChecker } from "./resourceBodyChecker";
import { createChildScope, createScope, lookup } from "./scopes";
import { createModuleNamespaceType } from "./moduleNamespace";
import {
  installPrelinkedTypeAliases,
  predeclareTypeAliases,
  resolveTypeAliases
} from "./typeAliases";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  anyType,
  identifierName,
  jsonType,
  modelIdType,
  resourceIdType,
  RsglBindOptions,
  RsglExportRecord,
  RsglImportRecord,
  RsglOutputResourcePreview,
  RsglReferenceRecord,
  RsglScope,
  RsglSemanticModel,
  RsglSymbol,
  RsglBlockstateModelSpecRecord,
  RsglBlockstateContextualExpressionRecord,
  RsglContextualTextureSinkRecord,
  RsglTemplateUseRecord,
  RsglType,
  textureRefType,
  typeFromAnnotation
} from "./types";
import type { RsglTemplateCallerContext } from "../templateOutput";
import {
  templateOutputBodyCallerContext,
  templateOutputMetadataForDeclaration
} from "../templateOutput";
import { validateResolvedTemplateUses } from "./templateUseValidation";
import { validateTemplateRecursion } from "./templateRecursion";

export function bindRsglModule(module: RsglModule, options: RsglBindOptions = {}): RsglSemanticModel {
  const binder = new RsglBinder(module, options.fileName ?? "<anonymous>", options);
  const model = binder.bind();
  model.diagnostics.push(...validateResolvedTemplateUses(model));
  model.diagnostics.push(...validateTemplateRecursion([model]).map(item => ({
    code: item.code,
    message: item.message,
    range: item.range,
    severity: item.severity
  })));
  return model;
}

class RsglBinder implements RsglExpressionCheckContext {
  public readonly diagnostics: RsglDiagnostic[] = [];
  public readonly references: RsglReferenceRecord[] = [];
  private readonly symbols: RsglSymbol[] = [];
  private readonly imports: RsglImportRecord[] = [];
  private readonly exports: RsglExportRecord[] = [];
  private readonly outputResources: RsglOutputResourcePreview[] = [];
  private readonly importCallScopes = new Map<ExprNode, RsglScope>();
  private readonly resolvedExpectedTypes = new Map<ExprNode, RsglType>();
  private readonly resolvedExpressionTypes = new Map<ExprNode, RsglType>();
  private readonly templateUses: RsglTemplateUseRecord[] = [];
  private readonly contextualTextureSinks: RsglContextualTextureSinkRecord[] = [];
  private readonly blockstateModelSpecRecords: RsglBlockstateModelSpecRecord[] = [];
  private readonly blockstateContextualExpressionRecords: RsglBlockstateContextualExpressionRecord[] = [];
  private readonly unsupportedDefaultImportNames = new Set<string>();
  private readonly globalScope: RsglScope = createScope("global");
  private readonly bodyChecker: RsglResourceBodyChecker;
  private enclosingTemplate: TemplateDeclNode | undefined;
  private namespace: string | undefined;

  public constructor(
    private readonly module: RsglModule,
    private readonly fileName: string,
    private readonly options: RsglBindOptions
  ) {
    this.bodyChecker = new RsglResourceBodyChecker(this, (statements, scope, callerContext) => {
      this.predeclareTopLevel(statements, scope);
      this.checkTopLevelStatements(statements, scope, callerContext);
      applyLambdaValueDiagnostics(this.diagnostics, statements, scope);
    }, (expression, scope, callerContext) => {
      this.templateUses.push({
        expression,
        scope: snapshotScope(scope, [expression]),
        callerContext,
        enclosingTemplate: this.enclosingTemplate
      });
    }, (expression, actualType, scope) => {
      if (this.enclosingTemplate) {
        this.contextualTextureSinks.push({
          expression,
          actualType,
          scope: snapshotScope(scope, [expression]),
          enclosingTemplate: this.enclosingTemplate
        });
      }
    }, (node, scope) => {
      this.blockstateModelSpecRecords.push({
        node,
        scope: snapshotScope(scope, blockstateModelSpecExpressions(node))
      });
    }, (record, scope) => {
      this.blockstateContextualExpressionRecords.push({
        ...record,
        scope: snapshotScope(scope, [record.expression])
      } as RsglBlockstateContextualExpressionRecord);
    });
  }

  public bind(): RsglSemanticModel {
    this.module.diagnostics.forEach(item => this.diagnostics.push(item));
    for (const symbol of createBuiltinSymbols()) {
      this.define(this.globalScope, symbol);
    }

    installPrelinkedTypeAliases(this.globalScope, this.options.prelinkedTypeAliases);
    predeclareTypeAliases(this.module.statements, this.globalScope, this.diagnostics);
    resolveTypeAliases(this.globalScope, this.diagnostics);
    this.predeclareTopLevel(this.module.statements, this.globalScope);
    this.installPrelinkedValueImports(this.globalScope);
    this.checkTopLevelStatements(this.module.statements, this.globalScope, resourcesCallerContext);
    applyLambdaValueDiagnostics(this.diagnostics, this.module.statements, this.globalScope);
    this.diagnostics.push(...exportedLambdaAnnotationDiagnostics(this.module.statements, this.globalScope));

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
      resolvedExpectedTypes: this.resolvedExpectedTypes,
      resolvedExpressionTypes: this.resolvedExpressionTypes,
      importCallScopes: this.importCallScopes,
      templateUses: this.templateUses,
      contextualTextureSinks: this.contextualTextureSinks,
      blockstateModelSpecRecords: this.blockstateModelSpecRecords,
      blockstateContextualExpressionRecords: this.blockstateContextualExpressionRecords
    };
  }

  public recordImportCallScope(expression: ExprNode, scope: RsglScope): void {
    this.importCallScopes.set(expression, snapshotScope(scope, [expression]));
  }

  public recordResolvedExpectedType(expression: ExprNode, expectedType: RsglType): void {
    mergeResolvedExpectedTypeFact(this.resolvedExpectedTypes, expression, expectedType);
  }

  public recordResolvedExpressionType(expression: ExprNode, type: RsglType): void {
    this.resolvedExpressionTypes.set(expression, type);
  }

  public isUndefinedSymbolDiagnosticSuppressed(name: string): boolean {
    return this.unsupportedDefaultImportNames.has(name);
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
    if (this.rejectReservedValueBinding(name, identifier?.range ?? node.range)) {
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
        this.defineIdentifier(
          scope,
          statement.name,
          "variable",
          typeFromAnnotation(statement.typeAnnotation, scope, this.diagnostics),
          statement
        );
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

  private checkTopLevelStatements(
    statements: TopLevelStatementNode[],
    scope: RsglScope,
    callerContext?: RsglTemplateCallerContext
  ): void {
    for (const statement of statements) {
      if (statement.kind === "LetDecl") {
        const expectedType = typeFromAnnotation(statement.typeAnnotation, scope, this.diagnostics);
        const actualType = expectedType.kind === "StatePredicate"
          ? checkBlockstatePredicate(this, statement.value, scope)
          : checkExpressionForExpectedType(this, statement.value, scope, expectedType);
        checkAssignable(this, expectedType, actualType, statement.value);
        const name = identifierName(statement.name);
        const symbol = name ? lookup(scope, name) : undefined;
        if (symbol && symbol.node === statement) {
          if (!statement.typeAnnotation) {
            symbol.type = actualType;
          }
          symbol.finiteDomain = finiteStringDomain(statement.value, scope) ?? undefined;
          if (statement.value.kind === "LambdaExpr") {
            symbol.signature = lambdaSignature(statement.value, symbol.type);
          }
        }
      } else if (statement.kind === "TableDecl") {
        const tableType = checkObject(this, statement.body, scope);
        const name = identifierName(statement.name);
        const symbol = name ? lookup(scope, name) : undefined;
        if (symbol?.node === statement) {
          symbol.type = tableType;
        }
      } else if (statement.kind === "TemplateDecl") {
        this.checkTemplate(statement, scope);
      } else if (statement.kind === "ExternDecl") {
        this.checkExternDecl(statement);
      } else if (statement.kind === "ResourceDecl") {
        this.checkResourceDecl(statement, scope);
      } else if (statement.kind === "UseDecl") {
        checkTemplateUseExpression(this, statement.expression, scope);
        this.templateUses.push({
          expression: statement.expression,
          scope: snapshotScope(scope, [statement.expression]),
          callerContext,
          enclosingTemplate: this.enclosingTemplate
        });
      } else if (statement.kind === "ForStmt") {
        this.bodyChecker.checkForStatement(statement, scope, callerContext);
      } else if (statement.kind === "IfStmt") {
        checkCompileTimeCondition(this, statement.condition, scope);
        const thenScope = scopeForTruthyCondition(scope, statement.condition);
        this.bodyChecker.checkBody(
          statement.thenBody,
          thenScope === scope ? createChildScope(scope, "block") : thenScope,
          callerContext
        );
        if (statement.elseBody) {
          this.bodyChecker.checkBody(statement.elseBody, createChildScope(scope, "block"), callerContext);
        }
      } else if (statement.kind === "TargetDecl") {
        this.checkExpression(statement.value, scope);
      } else if (statement.kind === "OverlayDecl") {
        this.checkExpression(statement.directory, scope);
        if (statement.formatRange) {
          this.checkOverlayFormatExpression(statement.formatRange, scope);
        }
        this.bodyChecker.checkBody(statement.body, createChildScope(scope, "block"), resourcesCallerContext);
      }
    }
  }

  private checkTemplate(statement: TemplateDeclNode, parentScope: RsglScope): void {
    const scope = createChildScope(parentScope, "template");
    this.checkCallableParameters(statement.parameters, scope);
    const metadata = statement.name
      ? lookup(parentScope, statement.name.text)?.signature?.templateOutput
      : undefined;
    const callerContext = templateOutputBodyCallerContext(
      metadata ?? templateOutputMetadataForDeclaration(statement)
    );
    const previousTemplate = this.enclosingTemplate;
    this.enclosingTemplate = statement;
    this.bodyChecker.checkBody(statement.body, scope, callerContext);
    this.enclosingTemplate = previousTemplate;
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
      this.defineIdentifier(
        scope,
        parameter.name,
        "parameter",
        typeFromAnnotation(parameter.typeAnnotation, scope, this.diagnostics),
        parameter
      );
      if (parameter.defaultValue) {
        const expectedType = typeFromAnnotation(parameter.typeAnnotation, scope, this.diagnostics);
        const actualType = expectedType.kind === "StatePredicate"
          ? checkBlockstatePredicate(this, parameter.defaultValue, scope)
          : checkExpressionForExpectedType(this, parameter.defaultValue, scope, expectedType);
        checkAssignable(this, expectedType, actualType, parameter.defaultValue);
      }
    }
  }

  private checkResourceDecl(statement: ResourceDeclNode, scope: RsglScope): void {
    if (statement.id) {
      const pathStrategy = getRsglResourceKindDescriptor(statement.resourceKind)?.emit.pathStrategy;
      if (pathStrategy === "resourceId") {
        const actualType = checkExpressionForExpectedType(this, statement.id, scope, resourceIdType);
        checkAssignable(this, resourceIdType, actualType, statement.id);
      } else {
        // Pack-relative, mcmeta, and namespace-only targets are not
        // unambiguously ResourceId values and must stay ordinary strings.
        checkResourceIdExpression(this, statement.id, scope);
      }
      validateResourceLocationLike(this, statement.id);
    }
    if (statement.impl) {
      this.checkModelImpl(statement.impl, scope);
    }
    const bodyScope = createChildScope(scope, "block");
    const callerContext = resourceDeclarationCallerContext(statement);
    if (statement.resourceKind === "blockstate") {
      this.bodyChecker.checkBody(statement.body, bodyScope, callerContext);
    } else {
      this.bodyChecker.checkResourceBody(
        statement.body,
        bodyScope,
        statement.resourceKind,
        callerContext
      );
    }
  }

  private checkModelImpl(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "CallExpr") {
      this.checkModelImplParent(expression.callee, scope);
      expression.args.forEach(arg => this.checkModelImplTexture(arg.value, scope));
      return;
    }
    this.checkModelImplParent(expression, scope);
  }

  private checkModelImplParent(expression: ExprNode, scope: RsglScope): void {
    const actualType = checkExpressionForExpectedType(this, expression, scope, modelIdType);
    checkAssignable(this, modelIdType, actualType, expression);
  }

  private checkModelImplTexture(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "StringLiteral" && expression.value.startsWith("#")) {
      const actualType = checkExpressionForExpectedType(this, expression, scope, textureRefType);
      checkAssignable(this, textureRefType, actualType, expression);
      return;
    }
    const actualType = checkExpressionForExpectedType(this, expression, scope, textureRefType);
    checkAssignable(this, textureRefType, actualType, expression);
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
    if (statement.defaultName) {
      this.unsupportedDefaultImportNames.add(statement.defaultName.text);
    }
    if (!statement.source) {
      return;
    }

    const source = statement.source.value;
    const resolvedFileName = this.options.resolver?.resolveImport(this.fileName, source) ?? undefined;
    const record: RsglImportRecord = {
      source,
      node: statement,
      defaultName: statement.defaultName?.text,
      namespaceName: statement.namespaceName?.text,
      importAll: !statement.defaultName
        && !statement.namespaceName
        && statement.namedImports.length === 0,
      namedImports: statement.namedImports.map(item => ({
        imported: item.imported.text,
        local: item.local.text,
        range: item.range
      })),
      resolvedFileName
    };
    this.imports.push(record);

    if (statement.namespaceName) {
      const namespaceType = this.options.prelinkedModuleNamespaces?.get(statement.namespaceName.text)
        ?? createModuleNamespaceType(resolvedFileName ?? source);
      this.defineIdentifier(
        scope,
        statement.namespaceName,
        "namespace",
        namespaceType,
        statement
      );
    }

    for (const specifier of statement.namedImports) {
      if (!this.options.typeOnlyImportNames?.has(specifier.local.text)) {
        const prelinked = this.options.prelinkedValueImports?.get(specifier.local.text);
        this.defineIdentifier(
          scope,
          specifier.local,
          "import",
          prelinked?.type ?? anyType,
          specifier
        );
        const symbol = scope.symbols.get(specifier.local.text);
        if (prelinked && symbol?.node === specifier) {
          symbol.signature = prelinked.signature;
          symbol.finiteDomain = prelinked.finiteDomain;
        }
        if (symbol?.node === specifier) {
          symbol.importBinding = {
            kind: "named",
            ...(resolvedFileName ? { sourceFile: resolvedFileName } : {})
          };
        }
      }
    }
  }

  /** Installs linked bare-import bindings after local declarations have claimed their names. */
  private installPrelinkedValueImports(scope: RsglScope): void {
    for (const [name, prelinked] of this.options.prelinkedValueImports ?? []) {
      if (scope.symbols.has(name)) {
        continue;
      }
      this.define(scope, {
        name,
        kind: "import",
        importBinding: {
          kind: "all",
          ...(prelinked.importBinding?.sourceFile
            ? { sourceFile: prelinked.importBinding.sourceFile }
            : {})
        },
        type: prelinked.type,
        node: prelinked.node,
        range: prelinked.range,
        signature: prelinked.signature,
        finiteDomain: prelinked.finiteDomain
      });
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
    if (this.rejectReservedValueBinding(name, statement.name?.range ?? statement.range)) {
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
            type: typeFromAnnotation(parameter.typeAnnotation, scope, this.diagnostics),
            optional: Boolean(parameter.defaultValue),
            node: parameter
          })),
        returnType: jsonType,
        templateOutput: templateOutputMetadataForDeclaration(statement)
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

  private rejectReservedValueBinding(
    name: string,
    range: { start: number; end: number }
  ): boolean {
    if (name !== "$state") {
      return false;
    }
    this.diagnostics.push(diagnostic(
      "rsgl.reservedBlockstateStateNamespace",
      "'$state' is reserved for blockstate predicates and cannot be used as a value binding name.",
      range
    ));
    return true;
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

const resourcesCallerContext: RsglTemplateCallerContext = { kind: "resources" };

function resourceDeclarationCallerContext(statement: ResourceDeclNode): RsglTemplateCallerContext {
  if (statement.resourceKind !== "blockstate") {
    if (statement.resourceKind === "item") {
      return { kind: "itemModel" };
    }
    return { kind: "resourceBody", resourceKind: statement.resourceKind };
  }
  return {
    kind: "blockstateRoot",
    mode: statement.mode,
    allowRootMerge: true,
    allowBase: true
  };
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
 * Freezes only bindings referenced by the recorded expression. Local scopes
 * keep accreting symbols after a site is bound, while cloning every accumulated
 * map at every blockstate entry is quadratic. A flattened lexical overlay
 * preserves the winning symbol for each referenced name; the complete global
 * scope remains shared so the program linker can replace provisional imports.
 */
function snapshotScope(scope: RsglScope, expressions: readonly ExprNode[]): RsglScope {
  if (scope.kind === "global") {
    return scope;
  }
  const names = new Set<string>();
  for (const expression of expressions) {
    walkRsglExpression(expression, {
      enterExpression(node) {
        if (node.kind === "IdentifierExpr") {
          names.add(node.name.text);
        }
      }
    });
  }
  const symbols = new Map<string, RsglSymbol>();
  for (const name of names) {
    let owner: RsglScope | undefined = scope;
    while (owner && !owner.symbols.has(name)) {
      owner = owner.parent;
    }
    if (owner && owner.kind !== "global") {
      symbols.set(name, owner.symbols.get(name)!);
    }
  }
  let global: RsglScope = scope;
  while (global.parent) {
    global = global.parent;
  }
  return {
    kind: scope.kind,
    parent: global,
    symbols,
    typeAliases: new Map(scope.typeAliases)
  };
}

function blockstateModelSpecExpressions(node: BlockstateModelSpecNode): ExprNode[] {
  return [
    node.model,
    ...(node.options?.properties.flatMap(property => property.kind === "ObjectSpread"
      ? [property.expression]
      : [
          ...(property.key.kind === "DynamicKey" ? [property.key.expression] : []),
          property.value
        ]) ?? [])
  ];
}
