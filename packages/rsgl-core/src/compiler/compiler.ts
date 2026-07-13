import {
  BlockNode,
  ExprNode,
  ForStmtNode,
  LetDeclNode,
  ResourceDeclNode,
  ResourceStatementNode,
  RsglModule,
  TableDeclNode,
  TopLevelStatementNode
} from "../parser";
import { compileAtlasSpecialStatement } from "./atlasSugar";
import { BlockstateCompileOptions, compileBlockstateResource } from "./blockstateCompiler";
import {
  bindRsglProgram,
  type RsglBlockstateApplyFact,
  type RsglBlockstateApplySiteNode
} from "../semantic";
import {
  classifyResolvedTemplateOutputMetadata,
  type ResolvedTemplateOutputClassification
} from "../semantic/templateOutputResolution";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createProgramCompileEnvironments,
  createTemplateDefinition,
  refreshTemplateDefinitionFingerprint
} from "./environment";
import { compileEquipmentLayerStatement } from "./equipmentSugar";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  RawGlobLoader,
  bindEvaluationResult,
  evaluateExpression,
  evaluateExpressionResult,
  expressionEvaluationOrigin,
  hasEvaluationValueBinding
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import {
  resolveRsglCompileConfiguration,
  type ResolvedRsglCompileConfiguration
} from "./compileConfiguration";
import { compileItemSpecialStatement } from "./itemFragments";
import {
  JsonValue,
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglCompileResult,
  RsglMapping,
  RsglValidationReferenceOrigin
} from "./ir";
import { compileJsonResourceUseFragment, JsonResourceFragmentKind } from "./jsonResourceFragments";
import { createLoopContext as createEvaluationLoopContext, forEachLoopContext } from "./looping";
import { compileModelGeometryStatement } from "./modelGeometryDsl";
import {
  compileOverlayDecl,
  compilePackResource,
  compilePackSpecialStatement,
  pushOverlayPackUnit,
  PackOverlayCompileOptions,
  RsglOverlayEntry
} from "./packOverlayCompiler";
import { ResourceBodyCompileOptions, ResourceBodyFragment, ResourceBodyMapping, ResourceBodySpecialResult, resourceBodyToObject } from "./resourceBody";
import { compileResourceDeclaration, ResourceDeclarationCompilerHost } from "./resourceCompiler";
import { RsglTargetPackFormat } from "./target";
import {
  createTemplateExpansion,
  resolveTemplateDefinition,
  templateResourceBody,
  RsglCompileContext,
  TemplateExpansion,
  TemplateExpansionOptions
} from "./templateExpansion";
import { createRsglStdlibPreludeSourceFiles } from "../stdlib";
import {
  isItemModelStatement,
  normalizeFileName,
  normalizeJsonValue
} from "./compilerHelpers";
import { uniqueValues } from "../../../mc-assets/src";
import {
  isRsglGenericJsonResourceKind,
  type RsglResourceKind
} from "../resourceKinds";
import type { RsglTemplateCallerContext, TemplateOutputDispatch } from "../templateOutput";
import { RsglTemplateDispatchCache } from "./templateDispatchCache";

export {
  compileRsglDirectory,
  compileRsglFile,
  compileRsglModule,
  compileRsglProgram,
  loadRsglSourceFilesFromDirectory,
  loadRsglSourceFilesFromFile
} from "./compilePipeline";
export type {
  RsglCompileOptions,
  RsglDirectoryCompileOptions,
  RsglFileCompileOptions,
  RsglFileLoadOptions,
  RsglProgramCompileOptions
} from "./compilePipeline";

interface RsglCompilerOptions {
  fileName: string;
  namespace: string;
  stdlibTemplates?: RsglTemplateDefinition[];
  externalTemplates?: RsglTemplateDefinition[];
  externalValues?: RsglExternalValueDefinition[];
  environment?: RsglModuleCompileEnvironment;
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  targetPackFormat?: RsglTargetPackFormat;
  maxEvaluationItems?: number;
  stdlibRoot?: string;
  blockstateApplyFacts?: ReadonlyMap<RsglBlockstateApplySiteNode, RsglBlockstateApplyFact>;
}

export class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly dependencies: CompileDependency[] = [];
  private readonly dependencyKeys = new Set<string>();
  private readonly templates = new Map<string, RsglTemplateDefinition>();
  private readonly templateDispatchCache = new RsglTemplateDispatchCache();
  private readonly overlayEntries: RsglOverlayEntry[] = [];
  private readonly moduleValueBindingNames: ReadonlySet<string>;

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) {
    this.moduleValueBindingNames = new Set(module.statements.flatMap(statement =>
      (statement.kind === "LetDecl" || statement.kind === "TableDecl") && statement.name
        ? [statement.name.text]
        : []
    ));
  }

  public compile(): RsglCompileResult {
    const localDefinitions: RsglTemplateDefinition[] = [];
    const definitionTargetFingerprint = JSON.stringify(
      this.module.statements.filter(statement => statement.kind === "TargetDecl")
    );
    const definitionFingerprintContext = JSON.stringify({
      namespace: this.options.namespace,
      targetPackFormat: this.options.targetPackFormat
    });
    for (const template of this.options.stdlibTemplates ?? createRsglStdlibPreludeTemplates(this.options.stdlibRoot)) {
      this.registerTemplate(template);
    }
    for (const template of this.options.externalTemplates ?? []) {
      this.registerTemplate(template);
    }
    for (const statement of this.module.statements) {
      if (statement.kind === "TemplateDecl" && statement.name) {
        const environmentTemplate = this.options.environment?.allTemplates.get(statement.name.text);
        const classification = environmentTemplate
          ? undefined
          : classifyResolvedTemplateOutputMetadata(
            statement,
            name => templateDefinitionClassification(this.templates.get(name))
              ?? (this.moduleValueBindingNames.has(name) ? null : undefined)
          );
        const template = environmentTemplate
          ?? createTemplateDefinition(
            statement.name.text,
            statement,
            this.options.fileName,
            this.options.namespace,
            new Map(),
            this.templates,
            classification!.metadata,
            definitionTargetFingerprint,
            definitionFingerprintContext,
            classification!.kind === "conflict" ? classification!.conflict : undefined
          );
        if (!environmentTemplate) {
          localDefinitions.push(template);
        }
        this.registerTemplate(template);
      }
    }
    // Local fallback definitions share the completed local map. Refresh only
    // those compiler-owned definitions so forward callees enter the closure
    // without rewriting imported/shared definitions for the caller namespace.
    for (const definition of localDefinitions) {
      refreshTemplateDefinitionFingerprint(definition, definitionFingerprintContext);
    }
    const context = this.createRootContext();
    for (const statement of this.module.statements) {
      this.compileStatement(statement, context);
    }
    pushOverlayPackUnit(this.packOverlayOptions());
    return { units: this.units, diagnostics: this.diagnostics, dependencies: this.dependencies };
  }

  private compileStatement(statement: TopLevelStatementNode, context: RsglCompileContext): void {
    if (statement.kind === "ResourceDecl") {
      this.compileResourceDecl(statement, context);
    } else if (statement.kind === "LetDecl") {
      this.compileLetDecl(statement, context);
    } else if (statement.kind === "TableDecl") {
      this.compileTableDecl(statement, context);
    } else if (statement.kind === "UseDecl") {
      this.compileUseDecl(statement.expression, context);
    } else if (statement.kind === "OverlayDecl") {
      compileOverlayDecl(statement, context, this.packOverlayOptions());
    } else if (statement.kind === "ForStmt") {
      this.compileForStmt(statement, context);
    } else if (statement.kind === "IfStmt") {
      if (evaluateExpression(statement.condition, context)) {
        if (statement.thenBody.kind === "Block") {
          this.compileBlock(statement.thenBody, context);
        }
      } else if (statement.elseBody) {
        if (statement.elseBody.kind === "Block") {
          this.compileBlock(statement.elseBody, context);
        }
      }
    }
  }

  private compileResourceDecl(statement: ResourceDeclNode, context: RsglCompileContext): void {
    const externalTextureVariables = statement.resourceKind === "model"
      ? uniqueValues(statement.body.statements
        .filter(bodyStatement => bodyStatement.kind === "ExternVarStmt")
        .flatMap(bodyStatement => bodyStatement.variables.map(variable => variable.text)))
      : [];
    for (const unit of compileResourceDeclaration(statement, context, this.resourceDeclarationCompilerHost())) {
      const referenceOrigins = this.detachValidationOrigins(unit);
      const resourceIdOrigin = statement.id
        ? expressionEvaluationOrigin(statement.id, context)
        : undefined;
      if (unit.kind === "mcmeta" && resourceIdOrigin) {
        referenceOrigins.push({ generatedPath: "/@resource-id", ...resourceIdOrigin });
      }
      if (unit.kind === "model" && externalTextureVariables.length > 0) {
        unit.validation = { ...unit.validation, externalTextureVariables };
      }
      if (referenceOrigins.length > 0) {
        unit.validation = {
          ...unit.validation,
          referenceOrigins: [...(unit.validation?.referenceOrigins ?? []), ...referenceOrigins]
        };
      }
      this.pushUnit(unit);
    }
  }

  private detachValidationOrigins(unit: ResourceUnit): RsglValidationReferenceOrigin[] {
    const origins: RsglValidationReferenceOrigin[] = [];
    const mappings = unit.sourceMap.mappings.flatMap(mapping => {
      if (!mapping.validationOrigin) {
        if (mapping.validationOnly) {
          return [];
        }
        return [mapping];
      }
      const { validationOrigin, validationOnly, ...publicMapping } = mapping;
      origins.push({ generatedPath: mapping.generatedPath, ...validationOrigin });
      return validationOnly ? [] : [publicMapping];
    });
    if (origins.length > 0) {
      unit.sourceMap = { ...unit.sourceMap, mappings };
    }
    return origins;
  }

  private resourceDeclarationCompilerHost(): ResourceDeclarationCompilerHost {
    return {
      fileName: this.options.fileName,
      compileBlockstate: (statement, context) =>
        compileBlockstateResource(statement, context, this.blockstateCompileOptions()),
      compilePack: (statement, context) =>
        compilePackResource(statement, context, this.packOverlayOptions()),
      compileBody: (body, context, resourceKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(resourceKind), allowBase: true }
        ),
      compileJsonBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.jsonResourceFragmentOptions(fragmentKind), allowBase: true }
        ),
      compileRawBody: (body, context, resourceKind) =>
        this.resourceBodyToObjectWithRawMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(resourceKind), allowBase: true }
        ),
      onError: (code, message, range) => this.error(code, message, range),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context)
    };
  }

  private compileLetDecl(statement: LetDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      bindEvaluationResult(
        context,
        statement.name.text,
        evaluateExpressionResult(statement.value, context)
      );
    }
  }

  private compileTableDecl(statement: TableDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      const result = evaluateExpressionResult(statement.body, context);
      bindEvaluationResult(context, statement.name.text, {
        ...result,
        value: normalizeJsonValue(result.value)
      });
    }
  }

  private compileUseDecl(expression: ExprNode, context: RsglCompileContext): void {
    const definition = this.findTemplateDefinition(expression, context);
    if (!definition) {
      this.error("rsgl.unknownTemplate", "Top-level use must expand a known template.", expression.range);
      return;
    }
    const dispatch = this.resolveTemplateDispatch(definition, { kind: "resources" });
    if (!dispatch.compatible) {
      return;
    }
    const expansion = this.createTemplateExpansion(expression, context, definition);
    if (!expansion) {
      return;
    }
    if (definition.node.body.kind !== "Block") {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' expands resource body content and must be used inside a resource declaration.`,
        expression.range
      );
      return;
    }
    this.compileBlock(definition.node.body, expansion.context);
  }

  private compileResourceBodyFragment(
    useStatement: Extract<ResourceStatementNode, { kind: "UseDecl" }>,
    context: RsglCompileContext,
    kind: Exclude<RsglResourceKind, "blockstate">
  ): ResourceBodyFragment | undefined {
    const definition = this.findTemplateDefinition(useStatement.expression, context);
    if (!definition) {
      return undefined;
    }
    const dispatch = this.resolveTemplateDispatch(definition, { kind: "resourceBody", resourceKind: kind });
    if (!dispatch.compatible) {
      return { content: {}, mappings: [] };
    }
    const expansion = this.createTemplateExpansion(useStatement.expression, context, definition);
    if (!expansion) {
      return { content: {}, mappings: [] };
    }
    const resourceBody = templateResourceBody(definition.node.body);
    if (!resourceBody) {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' emits resources and cannot be used inside a resource body.`,
        useStatement.range
      );
      return undefined;
    }
    const body = this.resourceBodyToObjectWithRawMappings(
      resourceBody,
      expansion.context,
      { ...this.resourceBodyFragmentOptions(kind), allowBase: false }
    );
    return {
      content: body.content,
      mappings: body.mappings
    };
  }

  private createTemplateExpansion(
    expression: ExprNode,
    context: RsglCompileContext,
    definition?: RsglTemplateDefinition
  ): TemplateExpansion | undefined {
    return createTemplateExpansion(expression, context, this.templateExpansionOptions(), definition);
  }

  private findTemplateDefinition(
    expression: ExprNode,
    context: RsglCompileContext
  ): RsglTemplateDefinition | undefined {
    return resolveTemplateDefinition(expression, context, this.templates);
  }

  private compileForStmt(statement: ForStmtNode, context: RsglCompileContext): void {
    const body = statement.body;
    if (body.kind !== "Block") {
      return;
    }
    forEachLoopContext(statement, context, (code, message, range) => this.error(code, message, range), loopContext => {
      this.compileBlock(body, loopContext);
    });
  }

  private compileBlock(body: BlockNode, context: RsglCompileContext): void {
    const blockContext: RsglCompileContext = {
      ...context,
      valueBindingNames: new Set([
        ...(context.valueBindingNames ?? []),
        ...body.statements.flatMap(statement =>
          (statement.kind === "LetDecl" || statement.kind === "TableDecl") && statement.name
            ? [statement.name.text]
            : []
        )
      ])
    };
    for (const statement of body.statements) {
      this.compileStatement(statement, blockContext);
    }
  }

  private createRootContext(): RsglCompileContext {
    const externalValues = this.options.externalValues ?? [];
    return {
      namespace: this.options.namespace,
      variables: new Map<string, EvaluationValue>(
        externalValues.map(item => [item.name, item.value])
      ),
      valueOrigins: new Map(externalValues.flatMap(item =>
        item.origin ? [[item.name, item.origin] as const] : []
      )),
      valuePathOrigins: new Map(externalValues.flatMap(item =>
        item.pathOrigins ? [[item.name, item.pathOrigins] as const] : []
      )),
      valueIssues: new Map(externalValues.flatMap(item =>
        item.valueIssues ? [[item.name, item.valueIssues] as const] : []
      )),
      valueBindingNames: new Set([
        ...this.moduleValueBindingNames,
        ...externalValues.map(item => item.name)
      ]),
      sourceFile: this.options.fileName,
      mappingReason: "direct",
      expansionStack: [],
      baseDocumentLoader: this.options.baseDocumentLoader,
      globLoader: this.options.globLoader,
      onDependency: dependency => this.recordDependency(dependency),
      onError: (code, message, range, fileName) => this.error(code, message, range, fileName),
      templates: this.templates
    };
  }

  private createChildContext(
    context: RsglCompileContext,
    values: Record<string, EvaluationValue>,
    metadata: Partial<Pick<EvaluationContext, "sourceFile" | "mappingReason" | "expansionStack">> = {}
  ): RsglCompileContext {
    return {
      ...childEvaluationContext(context, values, metadata),
      templates: context.templates
    };
  }

  private createLoopContext(
    context: RsglCompileContext,
    bindings: Record<string, EvaluationValue>,
    sourceRange: { start: number; end: number }
  ): RsglCompileContext {
    return {
      ...createEvaluationLoopContext(context, bindings, sourceRange),
      templates: context.templates
    };
  }

  private pushUnit(unit: ResourceUnit | null): void {
    if (unit) {
      this.units.push(unit);
    }
  }

  private resourceBodyToObject(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): Record<string, JsonValue> {
    if (body.kind !== "ResourceBody") {
      this.error(
        "rsgl.invalidResourceBody",
        "A blockstate root body cannot be compiled by the generic resource-body compiler.",
        body.range
      );
      return {};
    }
    return resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range) => this.error(code, message, range)
    });
  }

  private resourceBodyToObjectWithMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: RsglMapping[] } {
    const bodyWithRawMappings = this.resourceBodyToObjectWithRawMappings(body, context, options);
    return {
      content: bodyWithRawMappings.content,
      mappings: bodyWithRawMappings.mappings.map(mapping => ({
        ...this.sourceMapping(mapping.generatedPath, mapping.sourceRange, mapping.context),
        ...(mapping.validationOrigin ? { validationOrigin: mapping.validationOrigin } : {}),
        ...(mapping.validationOnly ? { validationOnly: true } : {})
      }))
    };
  }

  private resourceBodyToObjectWithRawMappings(
    body: ResourceDeclNode["body"],
    context: RsglCompileContext,
    options: ResourceBodyCompileOptions = {}
  ): { content: Record<string, JsonValue>; mappings: ResourceBodyMapping[] } {
    if (body.kind !== "ResourceBody") {
      this.error(
        "rsgl.invalidResourceBody",
        "A blockstate root body cannot be compiled by the generic resource-body compiler.",
        body.range
      );
      return { content: {}, mappings: [] };
    }
    const mappings: ResourceBodyMapping[] = [];
    const content = resourceBodyToObject(body, context, {
      ...options,
      onError: (code, message, range) => this.error(code, message, range),
      onMapping: mapping => {
        mappings.push(mapping);
        options.onMapping?.(mapping);
      }
    });
    return { content, mappings };
  }

  private itemFragmentOptions() {
    return {
      onError: (code: string, message: string, range: { start: number; end: number }) => this.error(code, message, range)
    };
  }

  private resourceBodyFragmentOptions(kind: Exclude<RsglResourceKind, "blockstate">): ResourceBodyCompileOptions {
    return {
      onUseFragment: (useStatement, fragmentContext) => {
        const templateFragment = this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
        if (templateFragment) {
          return templateFragment;
        }
        const calleeName = useStatement.expression.kind === "CallExpr"
          && useStatement.expression.callee.kind === "IdentifierExpr"
          ? useStatement.expression.callee.name.text
          : undefined;
        if (
          calleeName
          && (
            this.moduleValueBindingNames.has(calleeName)
            || hasEvaluationValueBinding(fragmentContext, calleeName)
          )
        ) {
          return undefined;
        }
        if (kind !== "model" && kind !== "item" && isJsonResourceFragmentKind(kind)) {
          return compileJsonResourceUseFragment(kind, useStatement, fragmentContext, {
            onError: (code, message, range) => this.error(code, message, range)
          });
        }
        return undefined;
      },
      onSpecialStatement: (statement, fragmentContext) => {
        if (kind === "model") {
          return compileModelGeometryStatement(statement, fragmentContext, {
            onError: (code, message, range) => this.error(code, message, range)
          });
        }
        return kind === "item" && isItemModelStatement(statement)
          ? compileItemSpecialStatement(statement, fragmentContext, this.itemFragmentOptions())
          : undefined;
      }
    };
  }

  private packResourceBodyOptions(): ResourceBodyCompileOptions {
    return {
      ...this.resourceBodyFragmentOptions("pack"),
      onSpecialStatement: (statement, context) => compilePackSpecialStatement(statement, context, this.packOverlayOptions())
    };
  }

  private jsonResourceFragmentOptions(kind: JsonResourceFragmentKind): ResourceBodyCompileOptions {
    const baseOptions = this.resourceBodyFragmentOptions(kind);
    if (kind !== "atlas" && kind !== "equipment") {
      return baseOptions;
    }
    return {
      ...baseOptions,
      onSpecialStatement: (statement, context) =>
        this.compileJsonResourceSpecialStatement(kind, statement, context)
        ?? baseOptions.onSpecialStatement?.(statement, context)
    };
  }

  private compileJsonResourceSpecialStatement(
    kind: JsonResourceFragmentKind,
    statement: ResourceStatementNode,
    context: RsglCompileContext
  ): ResourceBodySpecialResult | undefined {
    if (kind === "atlas") {
      return compileAtlasSpecialStatement(
        statement,
        context,
        (body, bodyContext) => this.resourceBodyToObjectWithRawMappings(
          body,
          bodyContext,
          { ...this.resourceBodyFragmentOptions("atlas"), allowBase: false }
        ),
        { onError: (code, message, range) => this.error(code, message, range) }
      );
    }
    if (kind === "equipment" && statement.kind === "EquipmentLayerStmt") {
      return compileEquipmentLayerStatement(statement, context, {
        onError: (code, message, range) => this.error(code, message, range)
      });
    }
    return undefined;
  }

  private blockstateCompileOptions(): BlockstateCompileOptions {
    return {
      resolveTemplate: (statement, context) => this.findTemplateDefinition(statement.expression, context),
      expandUse: (statement, context, definition) =>
        this.createTemplateExpansion(statement.expression, context, definition),
      resolveTemplateDispatch: (definition, callerContext) =>
        this.resolveTemplateDispatch(definition, callerContext),
      onError: (code, message, range, fileName) => this.error(code, message, range, fileName),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context),
      getBlockstateApplyFact: node => this.options.blockstateApplyFacts?.get(node)
    };
  }

  private templateExpansionOptions(): TemplateExpansionOptions {
    return {
      templates: this.templates,
      baseDocumentLoader: this.options.baseDocumentLoader,
      globLoader: this.options.globLoader,
      onDependency: dependency => this.recordDependency(dependency),
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      onError: (code, message, range, fileName) => this.error(code, message, range, fileName),
      onDiagnostic: diagnostic => {
        this.diagnostics.push(diagnostic);
      }
    };
  }

  private registerTemplate(definition: RsglTemplateDefinition): void {
    this.templates.set(definition.name, definition);
  }

  private resolveTemplateDispatch(
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ): TemplateOutputDispatch {
    return this.templateDispatchCache.resolve(definition, callerContext);
  }

  private recordDependency(dependency: CompileDependency): void {
    const key = compileDependencyKey(dependency);
    if (this.dependencyKeys.has(key)) {
      return;
    }
    this.dependencyKeys.add(key);
    this.dependencies.push(dependency);
    this.options.onDependency?.(dependency);
  }

  private packOverlayOptions(): PackOverlayCompileOptions {
    return {
      fileName: this.options.fileName,
      targetPackFormat: this.options.targetPackFormat,
      units: this.units,
      overlayEntries: this.overlayEntries,
      onError: (code, message, range) => this.error(code, message, range),
      compileBlock: (body, context) => this.compileBlock(body, context),
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      compilePackBody: (body, context) => this.resourceBodyToObject(
        body,
        context,
        { ...this.packResourceBodyOptions(), allowBase: false }
      ),
      compilePackBodyWithMappings: (body, context) => this.resourceBodyToObjectWithMappings(
        body,
        context,
        { ...this.packResourceBodyOptions(), allowBase: true }
      ),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings)
    };
  }

  private sourceMap(
    outputPath: string,
    node: { range: { start: number; end: number } },
    context: RsglCompileContext,
    mappings: RsglMapping[] = []
  ) {
    return {
      generatedFile: outputPath,
      mappings: [
        this.sourceMapping("", node.range, context),
        ...mappings
      ]
    };
  }

  private sourceMapping(
    generatedPath: string,
    sourceRange: { start: number; end: number },
    context: Pick<RsglCompileContext, "sourceFile" | "mappingReason" | "expansionStack">
  ): RsglMapping {
    return {
      generatedPath,
      sourceFile: context.sourceFile ?? this.options.fileName,
      sourceRange,
      reason: context.mappingReason ?? "direct",
      expansionStack: context.expansionStack ?? []
    };
  }

  private error(code: string, message: string, range: { start: number; end: number }, fileName?: string): void {
    this.diagnostics.push({ code, message, range, severity: "error", ...(fileName ? { fileName } : {}) });
  }
}

function templateDefinitionClassification(
  definition: RsglTemplateDefinition | undefined
): ResolvedTemplateOutputClassification | undefined {
  if (!definition) {
    return undefined;
  }
  return definition.outputConflict
    ? {
        kind: "conflict",
        metadata: definition.outputMetadata,
        conflict: definition.outputConflict
      }
    : { kind: "resolved", metadata: definition.outputMetadata };
}

function compileDependencyKey(dependency: CompileDependency): string {
  const normalizedPath = normalizeDependencyIdentity(dependency.path);
  const normalizedSource = normalizeDependencyIdentity(dependency.sourceFile);
  return [
    normalizedPath,
    dependency.reason,
    normalizedSource,
    dependency.sourceRange.start,
    dependency.sourceRange.end
  ].join("\0");
}

function normalizeDependencyIdentity(fileName: string): string {
  const normalized = normalizeFileName(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isJsonResourceFragmentKind(
  kind: Exclude<RsglResourceKind, "blockstate">
): kind is JsonResourceFragmentKind {
  return kind === "mcmeta" || isRsglGenericJsonResourceKind(kind);
}

export function createRsglStdlibPreludeTemplates(
  stdlibRoot?: string,
  configuration: ResolvedRsglCompileConfiguration = resolveRsglCompileConfiguration()
): RsglTemplateDefinition[] {
  const files = createRsglStdlibPreludeSourceFiles({ stdlibRoot });
  if (files.length === 0) {
    return [];
  }

  const program = bindRsglProgram(files, { stdlibRoot });
  const environments = createProgramCompileEnvironments(
    program,
    configuration
  );
  return program.models.flatMap(model =>
    Array.from(environments.get(normalizeFileName(model.fileName))?.exportedTemplates.values() ?? [])
  );
}

