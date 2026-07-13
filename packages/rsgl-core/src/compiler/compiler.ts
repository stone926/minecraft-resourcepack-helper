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
import { bindRsglProgram } from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createProgramCompileEnvironments,
  createTemplateDefinition
} from "./environment";
import { compileEquipmentLayerStatement } from "./equipmentSugar";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  RawGlobLoader,
  bindEvaluationValue,
  evaluateExpression,
  expressionEvaluationOrigin
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
}

export class RsglCompiler {
  private readonly units: ResourceUnit[] = [];
  private readonly diagnostics: RsglCompileDiagnostic[] = [];
  private readonly dependencies: CompileDependency[] = [];
  private readonly dependencyKeys = new Set<string>();
  private readonly templates = new Map<string, RsglTemplateDefinition>();
  private readonly overlayEntries: RsglOverlayEntry[] = [];

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) { }

  public compile(): RsglCompileResult {
    for (const template of this.options.stdlibTemplates ?? createRsglStdlibPreludeTemplates(this.options.stdlibRoot)) {
      this.templates.set(template.name, template);
    }
    for (const template of this.options.externalTemplates ?? []) {
      this.templates.set(template.name, template);
    }
    for (const statement of this.module.statements) {
      if (statement.kind === "TemplateDecl" && statement.name) {
        const template = this.options.environment?.allTemplates.get(statement.name.text)
          ?? createTemplateDefinition(
            statement.name.text,
            statement,
            this.options.fileName,
            this.options.namespace,
            new Map(),
            this.templates
          );
        this.templates.set(statement.name.text, template);
      }
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
      compileBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(fragmentKind), allowBase: true }
        ),
      compileJsonBody: (body, context, fragmentKind) =>
        this.resourceBodyToObjectWithMappings(
          body,
          context,
          { ...this.jsonResourceFragmentOptions(fragmentKind), allowBase: true }
        ),
      compileRawBody: (body, context) =>
        this.resourceBodyToObjectWithRawMappings(
          body,
          context,
          { ...this.resourceBodyFragmentOptions(), allowBase: true }
        ),
      onError: (code, message, range) => this.error(code, message, range),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context)
    };
  }

  private compileLetDecl(statement: LetDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      bindEvaluationValue(
        context,
        statement.name.text,
        evaluateExpression(statement.value, context),
        expressionEvaluationOrigin(statement.value, context)
      );
    }
  }

  private compileTableDecl(statement: TableDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      bindEvaluationValue(
        context,
        statement.name.text,
        normalizeJsonValue(evaluateExpression(statement.body, context)),
        expressionEvaluationOrigin(statement.body, context)
      );
    }
  }

  private compileUseDecl(expression: ExprNode, context: RsglCompileContext): void {
    const expansion = this.createTemplateExpansion(expression, context);
    if (expansion) {
      if (expansion.definition.node.body.kind !== "Block") {
        this.error(
          "rsgl.invalidTemplateContext",
          `Template '${expansion.definition.name}' expands resource body content and must be used inside a resource declaration.`,
          expression.range
        );
        return;
      }
      this.compileBlock(expansion.definition.node.body, expansion.context);
      return;
    }
    this.error("rsgl.unknownTemplate", "Top-level use must expand a known template.", expression.range);
  }

  private compileResourceBodyFragment(
    useStatement: Extract<ResourceStatementNode, { kind: "UseDecl" }>,
    context: RsglCompileContext,
    kind?: "model" | "item" | JsonResourceFragmentKind
  ): ResourceBodyFragment | undefined {
    const expansion = this.createTemplateExpansion(useStatement.expression, context);
    if (!expansion) {
      return undefined;
    }
    const resourceBody = templateResourceBody(expansion.definition.node.body);
    if (!resourceBody) {
      this.error(
        "rsgl.invalidTemplateContext",
        `Template '${expansion.definition.name}' emits resources and cannot be used inside a resource body.`,
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
    context: RsglCompileContext
  ): TemplateExpansion | undefined {
    return createTemplateExpansion(expression, context, this.templateExpansionOptions());
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
    for (const statement of body.statements) {
      this.compileStatement(statement, context);
    }
  }

  private createRootContext(): RsglCompileContext {
    return {
      namespace: this.options.namespace,
      variables: new Map<string, EvaluationValue>(
        (this.options.externalValues ?? []).map(item => [item.name, item.value])
      ),
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

  private resourceBodyFragmentOptions(kind?: "model" | "item" | JsonResourceFragmentKind): ResourceBodyCompileOptions {
    return {
      onUseFragment: (useStatement, fragmentContext) => {
        const templateFragment = this.compileResourceBodyFragment(useStatement, fragmentContext, kind);
        if (templateFragment) {
          return templateFragment;
        }
        if (kind && kind !== "model" && kind !== "item") {
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
      ...this.resourceBodyFragmentOptions(),
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
      expandUse: (statement, context) => this.createTemplateExpansion(statement.expression, context),
      onError: (code, message, range) => this.error(code, message, range),
      sourceMap: (outputPath, node, context, mappings) => this.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.sourceMapping(generatedPath, sourceRange, context)
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

