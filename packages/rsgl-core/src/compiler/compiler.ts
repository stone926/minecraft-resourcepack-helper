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
import type { BlockstateCompileOptions } from "./blockstateCompiler";
import {
  type RsglType
} from "../semantic";
import {
  RsglExternalValueDefinition,
  RsglModuleCompileEnvironment,
  RsglTemplateDefinition,
  createTemplateDefinition,
  refreshTemplateDefinitionFingerprint
} from "./environment";
import {
  childEvaluationContext,
  EvaluationContext,
  EvaluationValue,
  RawGlobLoader,
  bindEvaluationResult,
  evaluateCompileTimeCondition,
  evaluateExpressionResult
} from "./evaluate";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import {
  DEFAULT_MAX_ITEM_MODEL_DEPTH,
} from "./compileConfiguration";
import {
  ResourceUnit,
  RsglCompileResult
} from "./ir";
import { createLoopContext as createEvaluationLoopContext, forEachLoopContext } from "./looping";
import {
  compileOverlayDecl,
  pushOverlayPackUnit,
  PackOverlayCompileOptions,
  RsglOverlayEntry
} from "./packOverlayCompiler";
import type { ResourceBodyFragment } from "./resourceBody";
import { compileResourceDeclaration } from "./resourceCompiler";
import type { RsglTargetPackFormat } from "./targetConfig";
import {
  createTemplateExpansion,
  resolveTemplateDefinition,
  RsglCompileContext,
  TemplateExpansion,
  TemplateExpansionOptions
} from "./templateExpansion";
import { normalizeJsonValue } from "./compilerHelpers";
import { uniqueValues } from "../../../mc-assets/src";
import type { RsglResourceKind } from "../resourceKinds";
import {
  templateOutputMetadataForDeclaration,
  type RsglTemplateCallerContext,
  type TemplateOutputDispatch
} from "../templateOutput";
import { RsglTemplateDispatchCache } from "./templateDispatchCache";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import { finalizeResourceValueObservations } from "./resourceValueObservationFinalization";
import { EvaluationItemBudget } from "./evaluationItemBudget";
import { createRsglStdlibPreludeTemplates } from "./stdlibPrelude";
import { CompilerOutputAccumulator } from "./compilerOutputAccumulator";
import { ResourceBodyLowering } from "./resourceBodyLowering";

export { createRsglStdlibPreludeTemplates } from "./stdlibPrelude";

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
  maxItemModelDepth?: number;
  evaluationItemBudget?: EvaluationItemBudget;
  stdlibRoot?: string;
  resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>;
}

interface JsonValueLoweringSession {
  invalid: boolean;
  resourceValueObservations: RsglResourceValueObservation[];
}

export class RsglCompiler {
  private readonly output: CompilerOutputAccumulator;
  private readonly resourceBodies: ResourceBodyLowering;
  private readonly templates = new Map<string, RsglTemplateDefinition>();
  private readonly templateDispatchCache = new RsglTemplateDispatchCache();
  private readonly overlayEntries: RsglOverlayEntry[] = [];
  private readonly moduleValueBindingNames: ReadonlySet<string>;
  private activeJsonValueLoweringSession?: JsonValueLoweringSession;

  public constructor(
    private readonly module: RsglModule,
    private readonly options: RsglCompilerOptions
  ) {
    this.moduleValueBindingNames = new Set(module.statements.flatMap(statement =>
      (statement.kind === "LetDecl" || statement.kind === "TableDecl") && statement.name
        ? [statement.name.text]
        : []
    ));
    this.output = new CompilerOutputAccumulator({
      fileName: options.fileName,
      onDependency: options.onDependency
    });
    this.resourceBodies = new ResourceBodyLowering({
      fileName: options.fileName,
      maxItemModelDepth: options.maxItemModelDepth,
      moduleValueBindingNames: this.moduleValueBindingNames,
      blockstateCompileOptions: () => this.blockstateCompileOptions(),
      packOverlayOptions: () => this.packOverlayOptions(),
      compileResourceBodyFragment: (statement, context, kind) =>
        this.compileResourceBodyFragment(statement, context, kind),
      findTemplateDefinition: (expression, context) =>
        this.findTemplateDefinition(expression, context),
      createTemplateExpansion: (expression, context, definition) =>
        this.createTemplateExpansion(expression, context, definition),
      resolveTemplateDispatch: (definition, callerContext) =>
        this.resolveTemplateDispatch(definition, callerContext),
      sourceMap: (outputPath, node, context, mappings) =>
        this.output.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) =>
        this.output.sourceMapping(generatedPath, sourceRange, context),
      onError: (code, message, range, fileName) =>
        this.output.error(code, message, range, fileName),
      onWarning: (code, message, range, fileName) =>
        this.output.warning(code, message, range, fileName),
      onInvalidJsonValue: () => {
        if (this.activeJsonValueLoweringSession) {
          this.activeJsonValueLoweringSession.invalid = true;
        }
      },
      onResourceValueObservation: observation => {
        this.activeJsonValueLoweringSession?.resourceValueObservations.push(observation);
      }
    });
  }

  public compile(): RsglCompileResult {
    const localDefinitions: RsglTemplateDefinition[] = [];
    const definitionTargetFingerprint = JSON.stringify(
      this.module.statements.filter(statement => statement.kind === "TargetDecl")
    );
    const definitionFingerprintContext = JSON.stringify({
      namespace: this.options.namespace,
      targetPackFormat: this.options.targetPackFormat,
      maxItemModelDepth: this.options.maxItemModelDepth ?? DEFAULT_MAX_ITEM_MODEL_DEPTH
    });
    const resolvedExpectedTypes = this.options.resolvedExpectedTypes
      ?? this.options.environment?.resolvedExpectedTypes;
    for (const template of this.options.stdlibTemplates ?? createRsglStdlibPreludeTemplates(this.options.stdlibRoot)) {
      this.registerTemplate(template);
    }
    for (const template of this.options.externalTemplates ?? []) {
      this.registerTemplate(template);
    }
    for (const statement of this.module.statements) {
      if (statement.kind === "TemplateDecl" && statement.name) {
        const environmentTemplate = this.options.environment?.allTemplates.get(statement.name.text);
        const template = environmentTemplate
          ?? createTemplateDefinition(
            statement.name.text,
            statement,
            this.options.fileName,
            this.options.namespace,
            new Map(),
            this.templates,
            templateOutputMetadataForDeclaration(statement),
            definitionTargetFingerprint,
            definitionFingerprintContext,
            {
              ...(resolvedExpectedTypes ? { resolvedExpectedTypes } : {})
            }
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
    return this.output.result();
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
      const condition = evaluateCompileTimeCondition(statement.condition, context);
      if (condition === undefined) {
        return;
      }
      if (condition) {
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
    const previousSession = this.activeJsonValueLoweringSession;
    const session: JsonValueLoweringSession = {
      invalid: false,
      resourceValueObservations: []
    };
    const resourceContext: RsglCompileContext = {
      ...childEvaluationContext(context, {}),
      onEvaluationFailure: () => {
        session.invalid = true;
        context.onEvaluationFailure?.();
      },
      onResourceValueFailure: () => {
        session.invalid = true;
        context.onResourceValueFailure?.();
      }
    };
    this.activeJsonValueLoweringSession = session;
    let compiledUnits: ResourceUnit[];
    try {
      compiledUnits = compileResourceDeclaration(
        statement,
        resourceContext,
        this.resourceBodies.resourceDeclarationCompilerHost()
      );
    } finally {
      this.activeJsonValueLoweringSession = previousSession;
    }
    if (session.invalid) {
      return;
    }
    for (const unit of compiledUnits) {
      const referenceOrigins = this.output.detachValidationOrigins(unit);
      if (unit.kind === "model" && externalTextureVariables.length > 0) {
        unit.validation = { ...unit.validation, externalTextureVariables };
      }
      const resourceValueObservations = finalizeResourceValueObservations(
        unit,
        session.resourceValueObservations,
        referenceOrigins
      );
      if (resourceValueObservations.length > 0) {
        unit.validation = {
          ...unit.validation,
          resourceValueObservations: [
            ...(unit.validation?.resourceValueObservations ?? []),
            ...resourceValueObservations
          ]
        };
      }
      if (referenceOrigins.length > 0) {
        unit.validation = {
          ...unit.validation,
          referenceOrigins: [...(unit.validation?.referenceOrigins ?? []), ...referenceOrigins]
        };
      }
      this.output.pushUnit(unit);
    }
  }

  private compileLetDecl(statement: LetDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      if (this.bindPreEvaluatedLocal(statement, statement.name.text, context)) {
        return;
      }
      bindEvaluationResult(
        context,
        statement.name.text,
        evaluateExpressionResult(statement.value, context)
      );
    }
  }

  private compileTableDecl(statement: TableDeclNode, context: RsglCompileContext): void {
    if (statement.name) {
      if (this.bindPreEvaluatedLocal(statement, statement.name.text, context)) {
        return;
      }
      const result = evaluateExpressionResult(statement.body, context);
      bindEvaluationResult(context, statement.name.text, {
        ...result,
        value: normalizeJsonValue(result.value)
      });
    }
  }

  /**
   * Program/module environments evaluate direct top-level values once so
   * imports and template closures can capture them. Rebind that durable result
   * here instead of executing the initializer and charging its shared
   * collection budget a second time.
   */
  private bindPreEvaluatedLocal(
    statement: LetDeclNode | TableDeclNode,
    name: string,
    context: RsglCompileContext
  ): boolean {
    const result = this.options.environment?.localEvaluationResults?.get(statement);
    if (!result) {
      return false;
    }
    bindEvaluationResult(context, name, result, this.options.environment?.fileName);
    return true;
  }

  private compileUseDecl(expression: ExprNode, context: RsglCompileContext): void {
    const definition = this.findTemplateDefinition(expression, context);
    if (!definition) {
      this.output.error("rsgl.unknownTemplate", "Top-level use must expand a known template.", expression.range);
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
      this.output.error(
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
    if (definition.node.body.kind !== "ResourceBody") {
      this.output.error(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' emits resources and cannot be used inside a resource body.`,
        useStatement.range
      );
      return undefined;
    }
    const body = this.resourceBodies.compileTemplateFragmentBody(
      definition.node.body,
      expansion.context,
      kind
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
    forEachLoopContext(statement, context, (code, message, range) => this.output.error(code, message, range), loopContext => {
      this.compileBlock(body, loopContext);
    });
  }

  private compileBlock(body: BlockNode, context: RsglCompileContext): void {
    const blockContext: RsglCompileContext = {
      ...childEvaluationContext(context, {}),
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
      evaluationItemBudget: this.options.evaluationItemBudget
        ?? this.options.environment?.evaluationItemBudget
        ?? new EvaluationItemBudget(this.options.maxEvaluationItems),
      valueOrigins: new Map(externalValues.flatMap(item =>
        item.origin ? [[item.name, item.origin] as const] : []
      )),
      valuePathOrigins: new Map(externalValues.flatMap(item =>
        item.pathOrigins ? [[item.name, item.pathOrigins] as const] : []
      )),
      valueSelectionPathOrigins: new Map(externalValues.flatMap(item =>
        item.selectionPathOrigins ? [[item.name, item.selectionPathOrigins] as const] : []
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
      onDependency: dependency => this.output.recordDependency(dependency),
      onError: (code, message, range, fileName) => this.output.error(code, message, range, fileName),
      resolvedExpectedTypes: this.options.resolvedExpectedTypes
        ?? this.options.environment?.resolvedExpectedTypes,
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

  private blockstateCompileOptions(): BlockstateCompileOptions {
    return {
      resolveTemplate: (statement, context) => this.findTemplateDefinition(statement.expression, context),
      expandUse: (statement, context, definition) =>
        this.createTemplateExpansion(statement.expression, context, definition),
      resolveTemplateDispatch: (definition, callerContext) =>
        this.resolveTemplateDispatch(definition, callerContext),
      onError: (code, message, range, fileName) => this.output.error(code, message, range, fileName),
      sourceMap: (outputPath, node, context, mappings) => this.output.sourceMap(outputPath, node, context, mappings),
      sourceMapping: (generatedPath, sourceRange, context) => this.output.sourceMapping(generatedPath, sourceRange, context),
      onResourceValueObservation: observation => {
        this.activeJsonValueLoweringSession?.resourceValueObservations.push(observation);
      }
    };
  }

  private templateExpansionOptions(): TemplateExpansionOptions {
    return {
      templates: this.templates,
      baseDocumentLoader: this.options.baseDocumentLoader,
      globLoader: this.options.globLoader,
      onDependency: dependency => this.output.recordDependency(dependency),
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      onError: (code, message, range, fileName) => this.output.error(code, message, range, fileName),
      onDiagnostic: diagnostic => this.output.addDiagnostic(diagnostic)
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

  private packOverlayOptions(): PackOverlayCompileOptions {
    return {
      fileName: this.options.fileName,
      targetPackFormat: this.options.targetPackFormat,
      units: this.output.units,
      overlayEntries: this.overlayEntries,
      onError: (code, message, range) => this.output.error(code, message, range),
      compileBlock: (body, context) => this.compileBlock(body, context),
      createChildContext: (context, values, metadata) => this.createChildContext(context, values, metadata),
      compilePackBody: (body, context) => this.resourceBodies.resourceBodyToObject(
        body,
        context,
        { ...this.resourceBodies.packResourceBodyOptions(), allowBase: false }
      ),
      compilePackBodyWithMappings: (body, context) => this.resourceBodies.resourceBodyToObjectWithMappings(
        body,
        context,
        { ...this.resourceBodies.packResourceBodyOptions(), allowBase: true }
      ),
      sourceMap: (outputPath, node, context, mappings) =>
        this.output.sourceMap(outputPath, node, context, mappings)
    };
  }
}

