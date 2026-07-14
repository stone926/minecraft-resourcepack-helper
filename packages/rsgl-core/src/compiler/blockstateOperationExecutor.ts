import type {
  BlockstateMode,
  BlockstateMultipartEntryNode,
  BlockstateVariantEntryNode,
  MergeMode,
  PropertyStmtNode,
  TextRange
} from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import { applyBaseDocument } from "./base/application";
import {
  type BlockstateApplyLoweringHost,
  type BlockstateLoweredMapping,
  type LoweredBlockstateApply,
  lowerBlockstateApply
} from "./blockstateApplyLowerer";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import {
  mappingTargetsAppliedContent,
  offsetFragmentMappingPath,
  type MergeResult
} from "./fragmentMerge";
import {
  BlockstateRootMerger,
  type BlockstateBodyContent,
  type BlockstateContentMergeHost,
  type BlockstateRootFinalizeOrigin,
  type BlockstateRootState
} from "./blockstateContentMerge";
import {
  type BlockstateOperation,
  type BlockstateOperationProgram,
  type BlockstateProgramScope,
  templateBlockstateOperationProgram
} from "./blockstateOperations";
import {
  lowerBlockstateCondition,
  lowerBlockstateSelector
} from "./blockstateSelectorLowerer";
import { blockstateRootModeEvidence } from "./blockstateModePolicy";
import {
  blockstateMultipartPath,
  blockstateVariantPath,
} from "./compilerHelpers";
import {
  bindEvaluationResult,
  evaluateExpression,
  evaluateExpressionResult,
  type EvaluationOrigin,
  type EvaluationResult,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "./evaluate";
import type { RsglTemplateDefinition } from "./environment";
import type { JsonValue, RsglMapping } from "./ir";
import { isJsonObject } from "./jsonValues";
import {
  createJsonValueLoweringHost,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import { forEachLoopContext } from "./looping";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext, TemplateExpansion } from "./templateExpansion";

export interface BlockstateOperationExecutorHost
  extends BlockstateContentMergeHost, BlockstateApplyLoweringHost {
  resolveTemplate: (
    statement: Extract<BlockstateOperation, { kind: "Use" }>["statement"],
    context: RsglCompileContext
  ) => RsglTemplateDefinition | undefined;
  expandUse: (
    statement: Extract<BlockstateOperation, { kind: "Use" }>["statement"],
    context: RsglCompileContext,
    definition: RsglTemplateDefinition
  ) => TemplateExpansion | undefined;
  resolveTemplateDispatch: (
    definition: RsglTemplateDefinition,
    callerContext: RsglTemplateCallerContext
  ) => TemplateOutputDispatch;
}

export interface BlockstateRootExecutionOptions {
  declaredMode: BlockstateMode;
  finalizeOrigin?: BlockstateRootFinalizeOrigin;
  /** Selected fields are completed once, after the entire concrete root program. */
  finalizeSelectedMode: boolean;
}

export interface BlockstateRootExecutionResult extends BlockstateBodyContent {
  readonly mode: BlockstateMode;
}

interface ExecutionRoot {
  readonly state: BlockstateRootState;
}

interface ExecutionFrame {
  readonly scope: BlockstateProgramScope;
  readonly concreteRoot: boolean;
  readonly allowBase: boolean;
}

/** Executes every nested operation against one lazily mode-selected root state. */
export class BlockstateOperationExecutor {
  private readonly rootMerger: BlockstateRootMerger;
  private activeResourceValueObservations?: RsglResourceValueObservation[];

  public constructor(private readonly host: BlockstateOperationExecutorHost) {
    this.rootMerger = new BlockstateRootMerger(host);
  }

  public executeRoot(
    program: BlockstateOperationProgram,
    context: RsglCompileContext,
    options: BlockstateRootExecutionOptions
  ): BlockstateRootExecutionResult {
    const previousObservations = this.activeResourceValueObservations;
    const observations: RsglResourceValueObservation[] = [];
    this.activeResourceValueObservations = observations;
    try {
      const root: ExecutionRoot = {
        state: this.rootMerger.createState(options.declaredMode)
      };
      this.executeProgram(root, program, context, {
        scope: program.scope,
        concreteRoot: true,
        allowBase: true
      });

      if (options.finalizeSelectedMode) {
        this.rootMerger.finalize(root.state, options.finalizeOrigin ?? {
          sourceRange: program.range,
          context
        });
      }
      this.flushResourceValueObservations(observations, root.state.mappings);
      return {
        content: root.state.content,
        mappings: root.state.mappings,
        mode: root.state.mode
      };
    } finally {
      this.activeResourceValueObservations = previousObservations;
    }
  }

  private executeProgram(
    root: ExecutionRoot,
    program: BlockstateOperationProgram,
    context: RsglCompileContext,
    frame: ExecutionFrame
  ): void {
    const scopedFrame = { ...frame, scope: program.scope };
    for (const operation of program.operations) {
      this.executeOperation(root, operation, context, scopedFrame);
    }
  }

  private executeOperation(
    root: ExecutionRoot,
    operation: BlockstateOperation,
    context: RsglCompileContext,
    frame: ExecutionFrame
  ): void {
    if (operation.kind === "Let") {
      if (operation.statement.name) {
        const result = evaluateExpressionResult(operation.statement.value, context);
        bindEvaluationResult(
          context,
          operation.statement.name.text,
          result
        );
      }
      return;
    }
    if (operation.kind === "Use") {
      this.executeUse(root, operation, context, frame);
      return;
    }
    if (operation.kind === "Base") {
      this.executeBase(root, operation, context, frame);
      return;
    }
    if (operation.kind === "RootMerge") {
      this.executeRootMerge(root, operation, context);
      return;
    }
    if (operation.kind === "RootProperty") {
      this.executeRootProperty(root, operation.statement, context);
      return;
    }
    if (operation.kind === "VariantEntry") {
      this.executeVariantEntry(root, operation.statement, context);
      return;
    }
    if (operation.kind === "MultipartEntry") {
      this.executeMultipartEntry(root, operation.statement, context);
      return;
    }
    if (operation.kind === "For") {
      forEachLoopContext(
        operation.statement,
        context,
        (code, message, range) => this.host.onError(code, message, range),
        loopContext => this.executeProgram(root, operation.body, loopContext, {
          scope: operation.body.scope,
          concreteRoot: false,
          allowBase: false
        })
      );
      return;
    }
    if (operation.kind === "If") {
      const selected = evaluateExpression(operation.statement.condition, context)
        ? operation.thenProgram
        : operation.elseProgram;
      if (selected) {
        this.executeProgram(root, selected, context, {
          scope: selected.scope,
          concreteRoot: false,
          allowBase: false
        });
      }
    }
  }

  private executeUse(
    root: ExecutionRoot,
    operation: Extract<BlockstateOperation, { kind: "Use" }>,
    context: RsglCompileContext,
    frame: ExecutionFrame
  ): void {
    const definition = this.host.resolveTemplate(operation.statement, context);
    if (!definition) {
      return;
    }
    const callerContext = this.templateCallerContext(root, frame);
    // Dispatch is deliberately resolved before argument/default binding in expandUse.
    const dispatch = this.host.resolveTemplateDispatch(definition, callerContext);
    if (!dispatch.compatible) {
      return;
    }
    const expansion = this.host.expandUse(operation.statement, context, definition);
    if (!expansion) {
      return;
    }

    const dispatchedMode = blockstateModeFromDispatch(dispatch);
    if (dispatchedMode && !this.selectMode(root, dispatchedMode, {
      sourceRange: definition.node.body.range,
      context: expansion.context
    })) {
      return;
    }
    const templateBody = definition.node.body;
    if (templateBody.kind !== "VariantBody" && templateBody.kind !== "MultipartBody") {
      this.host.onError(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' emits resources and cannot be used inside a blockstate body.`,
        operation.statement.range
      );
      return;
    }
    const scope = blockstateScopeFromDispatch(dispatch, frame.scope);
    const program = templateBlockstateOperationProgram(templateBody);
    this.executeProgram(root, program, expansion.context, {
      scope,
      concreteRoot: false,
      allowBase: false
    });
  }

  private executeBase(
    root: ExecutionRoot,
    operation: Extract<BlockstateOperation, { kind: "Base" }>,
    context: RsglCompileContext,
    frame: ExecutionFrame
  ): void {
    const base = applyBaseDocument(operation.statement, context, {
      allowBase: frame.allowBase,
      isRoot: frame.concreteRoot,
      isFirstStatement: operation.sourceIndex === 0,
      onError: (code, message, range) => this.host.onError(code, message, range),
      createMapping: (generatedPath, sourceRange, mappingContext) =>
        this.host.sourceMapping(generatedPath, sourceRange, mappingContext)
    });
    if (!base) {
      return;
    }
    const evidence = blockstateRootModeEvidence(base.content);
    if (evidence === "both") {
      this.reportUnselectedModeConflict(operation.statement.range);
      return;
    }
    if (evidence !== "none" && !this.selectMode(root, evidence, {
      sourceRange: operation.statement.range,
      context
    })) {
      return;
    }
    this.rootMerger.initializeBase(
      root.state,
      base.content,
      operation.statement.range,
      base.mappings
    );
  }

  private executeRootMerge(
    root: ExecutionRoot,
    operation: Extract<BlockstateOperation, { kind: "RootMerge" }>,
    context: RsglCompileContext
  ): void {
    const result = evaluateExpressionResult(operation.statement.value, context);
    const observations: RsglResourceValueObservation[] = [];
    const loweringHost = createJsonValueLoweringHost(
      context,
      this.resourceValueCaptureHost(observations)
    );
    const value = lowerJsonEvaluationResult(
      result,
      operation.statement.value.range,
      loweringHost
    );
    if (value === undefined) {
      return;
    }
    if (!isJsonObject(value)) {
      this.host.onError(
        "rsgl.invalidMergeFragment",
        "merge must evaluate to an object fragment.",
        operation.statement.value.range
      );
      return;
    }
    const mappings = evaluationMappingsForValue(
      value,
      result,
      operation.statement.value.range,
      context,
      this.host
    );
    const mergeResult = this.applyRootOperand(
      root,
      value,
      operation.statement.mode,
      operation.statement.range,
      context,
      mappings
    );
    if (mergeResult) {
      this.commitMergedResourceValueObservations(observations, mergeResult);
    }
  }

  private executeRootProperty(
    root: ExecutionRoot,
    statement: PropertyStmtNode,
    context: RsglCompileContext
  ): void {
    const result = evaluateExpressionResult(statement.value, context);
    const path = appendGeneratedPath("", statement.name.text);
    const observations: RsglResourceValueObservation[] = [];
    const loweringHost = createJsonValueLoweringHost(
      context,
      this.resourceValueCaptureHost(observations)
    );
    loweringHost.generatedPathPrefix = path;
    const value = lowerJsonEvaluationResult(
      result,
      statement.value.range,
      loweringHost
    );
    if (value === undefined) {
      return;
    }
    const valueMappings = evaluationMappingsForValue(
      value,
      result,
      statement.value.range,
      context,
      this.host
    ).map(mapping => ({
      ...mapping,
      generatedPath: joinGeneratedPath(path, mapping.generatedPath)
    }));
    const mapping = this.host.sourceMapping(
      path,
      rangeForEvaluationPath(result.pathRanges, "") ?? statement.value.range,
      context
    );
    const mergeResult = this.applyRootOperand(
      root,
      { [statement.name.text]: value },
      "shallow",
      statement.range,
      context,
      [{
        ...mapping,
        ...((originForEvaluationPath(result.pathOrigins, "") ?? result.origin)
          ? { validationOrigin: originForEvaluationPath(result.pathOrigins, "") ?? result.origin }
          : {})
      }, ...valueMappings.filter(item => item.generatedPath !== path)]
    );
    if (mergeResult) {
      this.commitMergedResourceValueObservations(observations, mergeResult);
    }
  }

  private executeVariantEntry(
    root: ExecutionRoot,
    statement: BlockstateVariantEntryNode,
    context: RsglCompileContext
  ): void {
    const selectorExpression = statement.selector;
    const selector = lowerBlockstateSelector(selectorExpression, context, this.host);
    if (!selector || !this.selectMode(root, "variants", {
      sourceRange: selectorExpression.range,
      context
    })) {
      return;
    }
    const lowered = lowerBlockstateApply(statement.value, context, this.host);
    if (!lowered) {
      return;
    }
    const entryPath = blockstateVariantPath(selector.key);
    const entryMapping = this.host.sourceMapping(entryPath, selectorExpression.range, context);
    const mappings: RsglMapping[] = [{
      ...entryMapping,
      ...(selector.origin ? { validationOrigin: selector.origin } : {})
    }];
    mappings.push(...materializeMappings(
      lowered.mappings.filter(item => item.generatedPath !== ""),
      entryPath,
      context,
      this.host
    ));
    const inserted = this.rootMerger.insertVariant(
      root.state,
      selector.key,
      lowered.value,
      statement.range,
      context,
      mappings
    );
    if (inserted) {
      this.emitResourceValueObservations(lowered.resourceValueObservations, entryPath);
    }
  }

  private executeMultipartEntry(
    root: ExecutionRoot,
    statement: BlockstateMultipartEntryNode,
    context: RsglCompileContext
  ): void {
    if (!this.selectMode(root, "multipart", {
      sourceRange: statement.range,
      context
    })) {
      return;
    }
    const apply = lowerBlockstateApply(statement.apply, context, this.host);
    if (!apply) {
      return;
    }
    const value: Record<string, JsonValue> = { apply: apply.value };
    const mappings: BlockstateLoweredMapping[] = [relativeMapping("", statement.range)];
    mappings.push(...apply.mappings.map(item => ({
      ...item,
      generatedPath: joinGeneratedPath("/apply", item.generatedPath)
    })));
    if (statement.when) {
      const when = lowerBlockstateCondition(statement.when, context, this.host);
      if (!when) {
        return;
      }
      value.when = when.value;
      mappings.push(relativeMapping("/when", statement.when.range, when.origin));
    }
    const index = this.rootMerger.appendMultipart(
      root.state,
      value,
      statement.range,
      context,
      materializeMappings(mappings, "", context, this.host)
    );
    if (index !== undefined) {
      this.emitResourceValueObservations(
        apply.resourceValueObservations,
        joinGeneratedPath(blockstateMultipartPath(index), "/apply")
      );
    }
  }

  private emitResourceValueObservations(
    observations: LoweredBlockstateApply["resourceValueObservations"],
    generatedPathPrefix: string
  ): void {
    observations.forEach(observation => this.recordResourceValueObservation({
      ...observation,
      generatedPath: joinGeneratedPath(generatedPathPrefix, observation.generatedPath)
    }));
  }

  private resourceValueCaptureHost(
    observations: RsglResourceValueObservation[]
  ): BlockstateApplyLoweringHost {
    return {
      ...this.host,
      onResourceValueObservation: observation => observations.push(observation)
    };
  }

  private commitMergedResourceValueObservations(
    observations: readonly RsglResourceValueObservation[],
    mergeResult: MergeResult
  ): void {
    for (const observation of observations) {
      if (!mappingTargetsAppliedContent(observation.generatedPath, mergeResult.applied)) {
        continue;
      }
      this.recordResourceValueObservation({
        ...observation,
        generatedPath: offsetFragmentMappingPath(
          observation.generatedPath,
          mergeResult.arrayOffsets
        )
      });
    }
  }

  private recordResourceValueObservation(observation: RsglResourceValueObservation): void {
    if (this.activeResourceValueObservations) {
      this.activeResourceValueObservations.push(observation);
      return;
    }
    this.host.onResourceValueObservation?.(observation);
  }

  private flushResourceValueObservations(
    observations: readonly RsglResourceValueObservation[],
    mappings: readonly RsglMapping[]
  ): void {
    const observe = this.host.onResourceValueObservation;
    if (!observe || observations.length === 0) {
      return;
    }
    const latestMappingByPath = new Map<string, RsglMapping>();
    mappings.forEach(mapping => latestMappingByPath.set(mapping.generatedPath, mapping));
    const effective = new Map<string, RsglResourceValueObservation>();
    for (const observation of observations) {
      const mapping = latestMappingByPath.get(observation.generatedPath);
      if (mapping && observationMatchesMapping(observation, mapping)) {
        effective.set(observation.generatedPath, observation);
      }
    }
    effective.forEach(observation => observe(observation));
  }

  private applyRootOperand(
    root: ExecutionRoot,
    content: Record<string, JsonValue>,
    mode: MergeMode,
    sourceRange: TextRange,
    context: RsglCompileContext,
    mappings?: readonly RsglMapping[]
  ): MergeResult | undefined {
    const evidence = blockstateRootModeEvidence(content);
    if (evidence === "both") {
      this.reportUnselectedModeConflict(sourceRange);
      return undefined;
    }
    if (evidence !== "none" && !this.selectMode(root, evidence, { sourceRange, context })) {
      return undefined;
    }
    return this.rootMerger.mergeRoot(root.state, content, mode, sourceRange, context, mappings);
  }

  private selectMode(
    root: ExecutionRoot,
    mode: BlockstateMode,
    origin: BlockstateRootFinalizeOrigin
  ): boolean {
    if (root.state.mode === mode) {
      return true;
    }
    this.host.onError(
      "rsgl.blockstateModeConflict",
      `A '${root.state.mode}' blockstate root cannot receive '${mode}' content.`,
      origin.sourceRange
    );
    return false;
  }

  private templateCallerContext(
    root: ExecutionRoot,
    frame: ExecutionFrame
  ): RsglTemplateCallerContext {
    if (frame.scope === "entries") {
      return {
        kind: "blockstateEntries",
        mode: root.state.mode,
        allowRootMerge: false,
        allowBase: false
      };
    }
    return {
      kind: "blockstateRoot",
      mode: root.state.mode,
      allowRootMerge: true,
      allowBase: false
    };
  }

  private reportUnselectedModeConflict(range: TextRange): void {
    this.host.onError(
      "rsgl.blockstateModeConflict",
      "A blockstate root operand cannot contain both 'variants' and 'multipart'.",
      range
    );
  }
}

function blockstateModeFromDispatch(dispatch: TemplateOutputDispatch): BlockstateMode | undefined {
  const selected = dispatch.selectedDialect;
  return selected === "variants" || selected === "multipart" ? selected : undefined;
}

function blockstateScopeFromDispatch(
  dispatch: TemplateOutputDispatch,
  fallback: BlockstateProgramScope
): BlockstateProgramScope {
  const selected = dispatch.selectedDialect;
  return selected === "variants" || selected === "multipart" ? "entries" : fallback;
}

function evaluationMappingsForValue(
  value: JsonValue,
  evaluation: EvaluationResult,
  sourceRange: TextRange,
  context: RsglCompileContext,
  host: BlockstateOperationExecutorHost,
  generatedPath = ""
): RsglMapping[] {
  const origin = originForEvaluationPath(evaluation.pathOrigins, generatedPath) ?? evaluation.origin;
  const mappings: RsglMapping[] = [{
    ...host.sourceMapping(
      generatedPath,
      rangeForEvaluationPath(evaluation.pathRanges, generatedPath) ?? sourceRange,
      context
    ),
    ...(origin ? { validationOrigin: origin } : {}),
  }];
  if (Array.isArray(value)) {
    value.forEach((item, index) => mappings.push(...evaluationMappingsForValue(
      item,
      evaluation,
      sourceRange,
      context,
      host,
      appendGeneratedPath(generatedPath, String(index))
    )));
  } else if (isJsonObject(value)) {
    Object.entries(value).forEach(([key, item]) => mappings.push(...evaluationMappingsForValue(
      item,
      evaluation,
      sourceRange,
      context,
      host,
      appendGeneratedPath(generatedPath, key)
    )));
  }
  return mappings;
}

function materializeMappings(
  mappings: readonly BlockstateLoweredMapping[],
  basePath: string,
  context: RsglCompileContext,
  host: BlockstateOperationExecutorHost
): RsglMapping[] {
  return mappings.map(item => ({
    ...host.sourceMapping(
      joinGeneratedPath(basePath, item.generatedPath),
      item.sourceRange,
      context
    ),
    ...(item.origin ? { validationOrigin: item.origin } : {})
  }));
}

function relativeMapping(
  generatedPath: string,
  sourceRange: TextRange,
  origin?: EvaluationOrigin
): BlockstateLoweredMapping {
  return { generatedPath, sourceRange, ...(origin ? { origin } : {}) };
}

function observationMatchesMapping(
  observation: RsglResourceValueObservation,
  mapping: RsglMapping
): boolean {
  const candidates = [
    { sourceFile: mapping.sourceFile, sourceRange: mapping.sourceRange },
    ...(mapping.validationOrigin ? [mapping.validationOrigin] : [])
  ];
  return candidates.some(candidate =>
    candidate.sourceRange.start === observation.range.start
    && candidate.sourceRange.end === observation.range.end
    && (!observation.sourceFile || candidate.sourceFile === observation.sourceFile)
  );
}
