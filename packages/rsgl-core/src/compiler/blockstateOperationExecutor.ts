import type {
  BlockstateMode,
  BlockstateMultipartEntryNode,
  BlockstateVariantEntryNode,
  MergeMode,
  MultipartEntryNode,
  PropertyStmtNode,
  TextRange,
  VariantEntryNode
} from "../parser";
import type {
  RsglTemplateCallerContext,
  TemplateOutputDispatch
} from "../templateOutput";
import { applyBaseDocument } from "./base/application";
import {
  type BlockstateApplyLoweringHost,
  type BlockstateLoweredMapping,
  lowerBlockstateApply,
  lowerLegacyBlockstateApply
} from "./blockstateApplyLowerer";
import {
  BlockstateContentMerger,
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
import { lowerSerializableBlockstateJsonValue } from "./blockstateJsonValueLowerer";
import { forEachLoopContext } from "./looping";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";
import {
  type RsglCompileContext,
  type TemplateExpansion,
  templateResourceBody
} from "./templateExpansion";

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
  /** Canonical declarations start selected; legacy declarations select lazily from runtime evidence. */
  declaredMode?: BlockstateMode;
  /** Canonical header origin overrides any mode-producing operation origin. */
  finalizeOrigin?: BlockstateRootFinalizeOrigin;
  /** Selected fields are completed once, after the entire concrete root program. */
  finalizeSelectedMode: boolean;
}

export interface BlockstateRootExecutionResult extends BlockstateBodyContent {
  readonly mode?: BlockstateMode;
}

interface ExecutionRoot {
  readonly neutral: BlockstateBodyContent;
  state?: BlockstateRootState;
  modeOrigin?: BlockstateRootFinalizeOrigin;
}

interface ExecutionFrame {
  readonly scope: BlockstateProgramScope;
  readonly concreteRoot: boolean;
  readonly allowBase: boolean;
}

/** Executes every nested operation against one lazily mode-selected root state. */
export class BlockstateOperationExecutor {
  private readonly rootMerger: BlockstateRootMerger;
  private readonly contentMerger: BlockstateContentMerger;

  public constructor(private readonly host: BlockstateOperationExecutorHost) {
    this.rootMerger = new BlockstateRootMerger(host);
    this.contentMerger = new BlockstateContentMerger(host);
  }

  public executeRoot(
    program: BlockstateOperationProgram,
    context: RsglCompileContext,
    options: BlockstateRootExecutionOptions
  ): BlockstateRootExecutionResult {
    const root: ExecutionRoot = { neutral: { content: {}, mappings: [] } };
    if (options.declaredMode) {
      this.selectMode(root, options.declaredMode, options.finalizeOrigin ?? {
        sourceRange: program.range,
        context
      });
    }
    this.executeProgram(root, program, context, {
      scope: program.scope,
      concreteRoot: true,
      allowBase: true
    });

    if (root.state && options.finalizeSelectedMode) {
      this.rootMerger.finalize(root.state, options.finalizeOrigin ?? root.modeOrigin);
    }
    const body = root.state ?? root.neutral;
    return {
      content: body.content,
      mappings: body.mappings,
      ...(root.state ? { mode: root.state.mode } : {})
    };
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
    if (operation.kind === "Entries") {
      if (this.selectMode(root, operation.mode, {
        sourceRange: operation.statement.range,
        context
      })) {
        this.executeProgram(root, operation.body, context, {
          scope: "entries",
          concreteRoot: false,
          allowBase: false
        });
      }
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
    const mode = dispatchedMode ?? root.state?.mode;
    if (!mode) {
      this.host.onError(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' does not determine a blockstate mode in this legacy context.`,
        operation.statement.range
      );
      return;
    }

    const templateBody = definition.node.body;
    const body = templateBody.kind === "VariantBody" || templateBody.kind === "MultipartBody"
      ? templateBody
      : templateResourceBody(templateBody);
    if (!body) {
      this.host.onError(
        "rsgl.invalidTemplateContext",
        `Template '${definition.name}' emits resources and cannot be used inside a blockstate body.`,
        operation.statement.range
      );
      return;
    }
    const scope = blockstateScopeFromDispatch(dispatch, frame.scope);
    const program = templateBlockstateOperationProgram(body, mode, scope);
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
    if (root.state) {
      this.rootMerger.initializeBase(
        root.state,
        base.content,
        operation.statement.range,
        base.mappings
      );
      return;
    }
    root.neutral.content = base.content;
    root.neutral.mappings.length = 0;
    root.neutral.mappings.push(...base.mappings);
  }

  private executeRootMerge(
    root: ExecutionRoot,
    operation: Extract<BlockstateOperation, { kind: "RootMerge" }>,
    context: RsglCompileContext
  ): void {
    const result = evaluateExpressionResult(operation.statement.value, context);
    const value = lowerSerializableBlockstateJsonValue(
      result,
      operation.statement.value.range,
      this.host
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
    this.applyRootOperand(
      root,
      value,
      operation.statement.mode,
      operation.statement.range,
      context,
      mappings
    );
  }

  private executeRootProperty(
    root: ExecutionRoot,
    statement: PropertyStmtNode,
    context: RsglCompileContext
  ): void {
    const result = evaluateExpressionResult(statement.value, context);
    const value = lowerSerializableBlockstateJsonValue(
      result,
      statement.value.range,
      this.host
    );
    if (value === undefined) {
      return;
    }
    const path = appendGeneratedPath("", statement.name.text);
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
    this.applyRootOperand(
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
  }

  private executeVariantEntry(
    root: ExecutionRoot,
    statement: BlockstateVariantEntryNode | VariantEntryNode,
    context: RsglCompileContext
  ): void {
    const selectorExpression = statement.kind === "BlockstateVariantEntry"
      ? statement.selector
      : statement.state;
    const selector = lowerBlockstateSelector(selectorExpression, context, this.host);
    if (!selector || !this.selectMode(root, "variants", {
      sourceRange: selectorExpression.range,
      context
    })) {
      return;
    }
    const lowered = statement.kind === "BlockstateVariantEntry"
      ? lowerBlockstateApply(statement.value, context, this.host)
      : lowerLegacyBlockstateApply(statement.value, context);
    if (!lowered || !root.state) {
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
    this.rootMerger.insertVariant(
      root.state,
      selector.key,
      lowered.value,
      statement.range,
      context,
      mappings
    );
  }

  private executeMultipartEntry(
    root: ExecutionRoot,
    statement: BlockstateMultipartEntryNode | MultipartEntryNode,
    context: RsglCompileContext
  ): void {
    if (!this.selectMode(root, "multipart", {
      sourceRange: statement.range,
      context
    })) {
      return;
    }
    const apply = statement.kind === "BlockstateMultipartEntry"
      ? lowerBlockstateApply(statement.apply, context, this.host)
      : lowerLegacyBlockstateApply(statement.apply, context);
    if (!apply || !root.state) {
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
    this.rootMerger.appendMultipart(
      root.state,
      value,
      statement.range,
      context,
      materializeMappings(mappings, "", context, this.host)
    );
  }

  private applyRootOperand(
    root: ExecutionRoot,
    content: Record<string, JsonValue>,
    mode: MergeMode,
    sourceRange: TextRange,
    context: RsglCompileContext,
    mappings?: readonly RsglMapping[]
  ): void {
    const evidence = blockstateRootModeEvidence(content);
    if (evidence === "both") {
      if (root.state) {
        this.rootMerger.mergeRoot(root.state, content, mode, sourceRange, context, mappings);
      } else {
        this.reportUnselectedModeConflict(sourceRange);
      }
      return;
    }
    if (evidence !== "none" && !this.selectMode(root, evidence, { sourceRange, context })) {
      return;
    }
    if (root.state) {
      this.rootMerger.mergeRoot(root.state, content, mode, sourceRange, context, mappings);
    } else {
      this.contentMerger.applyWithResult(
        root.neutral,
        content,
        mode,
        sourceRange,
        context,
        mappings
      );
    }
  }

  private selectMode(
    root: ExecutionRoot,
    mode: BlockstateMode,
    origin: BlockstateRootFinalizeOrigin
  ): boolean {
    if (root.state) {
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
    const state = this.rootMerger.createState(mode);
    state.content = root.neutral.content;
    state.mappings.push(...root.neutral.mappings);
    root.state = state;
    root.modeOrigin = origin;
    return true;
  }

  private templateCallerContext(
    root: ExecutionRoot,
    frame: ExecutionFrame
  ): RsglTemplateCallerContext {
    if (frame.scope === "entries" && root.state) {
      return {
        kind: "blockstateEntries",
        mode: root.state.mode,
        allowRootMerge: false,
        allowBase: false
      };
    }
    return {
      kind: "blockstateRoot",
      mode: root.state?.mode ?? "neutral",
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
  if (selected === "variants" || selected === "multipart") {
    return selected;
  }
  if (selected && typeof selected === "object" && (
    selected.kind === "blockstateRoot" || selected.kind === "blockstateEntries"
  )) {
    return selected.mode === "neutral" ? undefined : selected.mode;
  }
  return undefined;
}

function blockstateScopeFromDispatch(
  dispatch: TemplateOutputDispatch,
  fallback: BlockstateProgramScope
): BlockstateProgramScope {
  const selected = dispatch.selectedDialect;
  return selected && typeof selected === "object" && selected.kind === "blockstateRoot"
    ? "root"
    : selected === "variants"
      || selected === "multipart"
      || (selected && typeof selected === "object" && selected.kind === "blockstateEntries")
      ? "entries"
      : fallback;
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
