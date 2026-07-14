import {
  ExprNode,
  ExternDeclNode,
  ForStmtNode,
  IdentifierNode,
  LegacyBlockstateRootBodyNode,
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
import { inferStaticBlockstateMode } from "../blockstateModeEvidence";
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
  checkExpression,
  checkExpressionForExpectedType,
  checkObject,
  checkResourceIdExpression,
  checkTemplateUseExpression,
  RsglExpressionCheckContext,
  validateResourceLocationLike
} from "./expressionChecker";
import { RsglResourceBodyChecker } from "./resourceBodyChecker";
import { applyLegacyBlockstateMode, resolveLegacyBlockstateMode } from "./blockstateModeInference";
import { createChildScope, createScope, lookup } from "./scopes";
import { createModuleNamespaceType } from "./moduleNamespace";
import {
  installPrelinkedTypeAliases,
  predeclareTypeAliases,
  resolveTypeAliases
} from "./typeAliases";
import { scopeForTruthyCondition } from "./typeNarrowing";
import {
  inferResolvedTemplateOutputMetadata,
  resolveProgramTemplateOutputMetadata,
  templateOutputClassificationForName
} from "./templateOutputResolution";
import {
  anyType,
  identifierName,
  jsonType,
  modelIdType,
  resourceIdType,
  RsglBindOptions,
  RsglExportRecord,
  RsglImportRecord,
  RsglLegacyBlockstateRootRecord,
  RsglOutputResourcePreview,
  RsglReferenceRecord,
  RsglScope,
  RsglSemanticModel,
  RsglSymbol,
  RsglBlockstateApplyFact,
  RsglBlockstateApplyRecord,
  RsglBlockstateApplySiteNode,
  RsglBlockstateContextualExpressionRecord,
  RsglContextualTextureSinkRecord,
  RsglTemplateUseRecord,
  RsglType,
  textureRefType,
  typeFromAnnotation
} from "./types";
import type { RsglTemplateCallerContext } from "../templateOutput";
import { templateOutputBodyCallerContext } from "../templateOutput";
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
  private readonly legacyBlockstateRoots: RsglLegacyBlockstateRootRecord[] = [];
  private readonly contextualTextureSinks: RsglContextualTextureSinkRecord[] = [];
  private readonly blockstateApplyFacts = new Map<RsglBlockstateApplySiteNode, RsglBlockstateApplyFact>();
  private readonly blockstateApplyRecords: RsglBlockstateApplyRecord[] = [];
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
    }, (node, scope, fact) => {
      this.blockstateApplyFacts.set(node, fact);
      this.blockstateApplyRecords.push({
        node,
        scope: snapshotScope(scope, blockstateApplySiteExpressions(node))
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
    this.resolveLocalTemplateOutputs();
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
      legacyBlockstateRoots: this.legacyBlockstateRoots,
      contextualTextureSinks: this.contextualTextureSinks,
      blockstateApplyFacts: this.blockstateApplyFacts,
      blockstateApplyRecords: this.blockstateApplyRecords,
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
        const actualType = checkExpressionForExpectedType(this, statement.value, scope, expectedType);
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
        this.checkExpression(statement.condition, scope);
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
    const callerContext = metadata ? templateOutputBodyCallerContext(metadata) : undefined;
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
        const actualType = checkExpressionForExpectedType(this, parameter.defaultValue, scope, expectedType);
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
    const templateUseStart = this.templateUses.length;
    const legacyMode = statement.resourceKind === "blockstate"
      && statement.blockstateSyntax !== "modeHeader"
      ? inferLegacyBlockstateMode(statement.body)
      : undefined;
    const callerContext = resourceDeclarationCallerContext(statement, legacyMode?.mode);
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
    if (statement.resourceKind === "blockstate" && statement.blockstateSyntax !== "modeHeader") {
      const record: RsglLegacyBlockstateRootRecord = {
        range: statement.body.range,
        directModes: legacyMode?.modes ?? [],
        uses: this.templateUses.slice(templateUseStart).filter(use =>
          use.callerContext?.kind === "blockstateRoot"
        )
      };
      const resolvedMode = resolveLegacyBlockstateMode(record);
      applyLegacyBlockstateMode(record, resolvedMode);
      this.legacyBlockstateRoots.push(record);
      if (resolvedMode.conflict) {
        this.diagnostics.push(diagnostic(
          "rsgl.blockstateModeConflict",
          "A legacy blockstate body contains both variants and multipart evidence; select one mode in the declaration header.",
          statement.body.range
        ));
      }
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
    if (
      expression.kind === "ResourceLocationExpr"
      || (
        expression.kind === "StringLiteral"
        && (expression.value.includes(":") || expression.value.includes("/"))
      )
    ) {
      // Already path-shaped text does not need the legacy subtype folder and
      // can safely participate in the normal ModelId fact pipeline.
      const actualType = checkExpressionForExpectedType(this, expression, scope, modelIdType);
      checkAssignable(this, modelIdType, actualType, expression);
      return;
    }
    const symbol = expression.kind === "IdentifierExpr"
      ? lookup(scope, expression.name.text)
      : undefined;
    if (
      expression.kind === "StringLiteral"
      || expression.kind === "TemplateStringExpr"
      || (expression.kind === "IdentifierExpr" && (!symbol || symbol.kind === "builtin"))
    ) {
      // Model impl text is a legacy subtype-relative shorthand. Keep it
      // unbranded so modelImpl can still expand `cube_all` to
      // `minecraft:block/cube_all`; explicitly typed ModelId values remain
      // branded and bypass that compatibility rule.
      checkResourceIdExpression(this, expression, scope);
      return;
    }
    const actualType = checkExpression(this, expression, scope);
    if (isLegacyModelImplParentType(actualType)) {
      return;
    }
    checkAssignable(this, modelIdType, actualType, expression);
  }

  private checkModelImplTexture(expression: ExprNode, scope: RsglScope): void {
    if (expression.kind === "StringLiteral" && expression.value.startsWith("#")) {
      const actualType = checkExpressionForExpectedType(this, expression, scope, textureRefType);
      checkAssignable(this, textureRefType, actualType, expression);
      return;
    }
    if (
      expression.kind === "ResourceLocationExpr"
      || (
        expression.kind === "StringLiteral"
        && (expression.value.includes(":") || expression.value.includes("/"))
      )
    ) {
      const actualType = checkExpressionForExpectedType(this, expression, scope, textureRefType);
      checkAssignable(this, textureRefType, actualType, expression);
      return;
    }
    if (
      expression.kind === "StringLiteral"
      || expression.kind === "TemplateStringExpr"
      || (expression.kind === "IdentifierExpr" && !lookup(scope, expression.name.text))
    ) {
      // As with the parent shorthand, raw text keeps its subtype-relative
      // spelling until modelImpl knows whether `block/` or `item/` applies.
      checkResourceIdExpression(this, expression, scope);
      return;
    }
    const actualType = checkExpression(this, expression, scope);
    if (isLegacyModelImplTextureType(actualType)) {
      return;
    }
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
        this.defineIdentifier(scope, specifier.local, "import", anyType, specifier);
      }
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
            type: typeFromAnnotation(parameter.typeAnnotation, scope, this.diagnostics),
            optional: Boolean(parameter.defaultValue),
            node: parameter
          })),
        returnType: jsonType,
        templateOutput: inferResolvedTemplateOutputMetadata(statement, calleeName =>
          templateOutputClassificationForName(scope, calleeName)
        )
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

  private resolveLocalTemplateOutputs(): void {
    const model: RsglSemanticModel = {
      fileName: this.fileName,
      module: this.module,
      scope: this.globalScope,
      symbols: this.symbols,
      imports: this.imports,
      exports: this.exports,
      references: this.references,
      outputResources: this.outputResources,
      diagnostics: this.diagnostics,
      resolvedExpectedTypes: this.resolvedExpectedTypes,
      resolvedExpressionTypes: this.resolvedExpressionTypes
    };
    resolveProgramTemplateOutputMetadata([model]);
  }
}

function isLegacyModelImplParentType(type: RsglType): boolean {
  if (
    type.kind === "String"
    || type.kind === "ModelId"
    || type.kind === "Any"
    || type.kind === "Unknown"
  ) {
    return true;
  }
  return type.kind === "Union"
    && (type.options?.length ?? 0) > 0
    && (type.options ?? []).every(isLegacyModelImplParentType);
}

function isLegacyModelImplTextureType(type: RsglType): boolean {
  if (
    type.kind === "String"
    || type.kind === "TextureId"
    || type.kind === "TextureVariable"
    || type.kind === "TextureRef"
    || type.kind === "Any"
    || type.kind === "Unknown"
  ) {
    return true;
  }
  return type.kind === "Union"
    && (type.options?.length ?? 0) > 0
    && (type.options ?? []).every(isLegacyModelImplTextureType);
}

const resourcesCallerContext: RsglTemplateCallerContext = { kind: "resources" };

function resourceDeclarationCallerContext(
  statement: ResourceDeclNode,
  inferredLegacyMode: "variants" | "multipart" | undefined = undefined
): RsglTemplateCallerContext {
  if (statement.resourceKind !== "blockstate") {
    return { kind: "resourceBody", resourceKind: statement.resourceKind };
  }
  return {
    kind: "blockstateRoot",
    mode: statement.blockstateSyntax === "modeHeader"
      ? statement.mode
      : inferredLegacyMode ?? "neutral",
    allowRootMerge: true,
    allowBase: true
  };
}

interface LegacyBlockstateModeEvidence {
  modes: readonly ("variants" | "multipart")[];
  mode?: "variants" | "multipart";
}

function inferLegacyBlockstateMode(body: LegacyBlockstateRootBodyNode): LegacyBlockstateModeEvidence {
  const modes = new Set<"variants" | "multipart">();
  collectLegacyBlockstateModeEvidence(body, modes);
  const values = Array.from(modes);
  return {
    modes: values,
    mode: values.length === 1 ? values[0] : undefined
  };
}

function collectLegacyBlockstateModeEvidence(
  body: LegacyBlockstateRootBodyNode | ForStmtNode["body"],
  modes: Set<"variants" | "multipart">
): void {
  if (!("statements" in body) || !Array.isArray(body.statements)) {
    return;
  }
  if (body.kind === "VariantBody" || body.kind === "BlockstateVariantsRootBody") {
    modes.add("variants");
  } else if (body.kind === "MultipartBody" || body.kind === "BlockstateMultipartRootBody") {
    modes.add("multipart");
  }
  for (const statement of body.statements) {
    if (statement.kind === "VariantsSection"
      || statement.kind === "VariantEntry"
      || statement.kind === "BlockstateVariantEntry") {
      modes.add("variants");
    } else if (statement.kind === "MultipartSection"
      || statement.kind === "MultipartEntry"
      || statement.kind === "BlockstateMultipartEntry") {
      modes.add("multipart");
    } else if (statement.kind === "MergeStmt") {
      const evidence = inferStaticBlockstateMode(statement.value);
      if (evidence === "variants" || evidence === "conflict") {
        modes.add("variants");
      }
      if (evidence === "multipart" || evidence === "conflict") {
        modes.add("multipart");
      }
    } else if (statement.kind === "ForStmt") {
      collectLegacyBlockstateModeEvidence(statement.body, modes);
    } else if (statement.kind === "IfStmt") {
      collectLegacyBlockstateModeEvidence(statement.thenBody, modes);
      if (statement.elseBody) {
        collectLegacyBlockstateModeEvidence(statement.elseBody, modes);
      }
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

function blockstateApplySiteExpressions(node: RsglBlockstateApplySiteNode): ExprNode[] {
  return [node.head, ...node.properties.map(property => property.value)];
}
