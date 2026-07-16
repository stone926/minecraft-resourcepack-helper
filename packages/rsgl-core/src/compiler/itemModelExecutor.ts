import type {
  ExprNode, ItemModelNode, ItemModelTemplateBodyNode, ItemRangeFramesNode, TextRange
} from "../parser";
import type { RsglTemplateCallerContext } from "../templateOutput";
import {
  bindEvaluationValue,
  childEvaluationContext,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  selectEvaluationPathOrigins,
  selectEvaluationValueIssues
} from "./evaluate";
import type { JsonValue } from "./ir";
import {
  collectItemFirstMatchClauses,
  expandItemCompositeBody,
  expandItemModelTemplateBody,
  expandItemRangeBody,
  expandItemSelectBody,
  reportItemModelBodyMismatch
} from "./itemModelClauseExpansion";
import type {
  ItemModelExecutorHost,
  LoweredItemModel,
  MutableItemModelLowering as MutableLowering
} from "./itemModelExecutorTypes";
import { stableJsonKey } from "./itemModelJson";
import { lowerItemModelExpression, lowerItemModelSpecial } from "./itemModelLeafLowerer";
import {
  commitCapturedItemModelObservations as commitCapturedObservations,
  evaluateCapturedItemModelExpression as evaluateCaptured,
  itemModelExpressionMappings as expressionMappings,
  itemModelNodeMapping as nodeMapping,
  terminalItemModel as terminalModel
} from "./itemModelLoweringSupport";
import {
  applyItemModelPostfixOptions as applyPostfixOptions,
  lowerItemPropertyHeader as lowerPropertyHeader
} from "./itemModelOptionsLowerer";
import type { ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";
import { DEFAULT_MAX_ITEM_MODEL_DEPTH } from "./compileConfiguration";
import { ensureEvaluationItemsForExpansion } from "./evaluationItemAccounting";

export { normalizeItemModelValue } from "./itemModelJson";
export type { ItemModelExecutorHost, LoweredItemModel } from "./itemModelExecutorTypes";

const itemModelCallerContext: RsglTemplateCallerContext = { kind: "itemModel" };

/** Lowers one recursive item-model node at its final JSON path. */
export function executeItemModelNode(
  node: ItemModelNode,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath = "/model",
  depth = 0
): LoweredItemModel | undefined {
  if (depth > (host.maxItemModelDepth ?? DEFAULT_MAX_ITEM_MODEL_DEPTH)) {
    host.onError?.(
      "rsgl.itemModelDepthExceeded",
      `Item-model node at '${generatedPath}' exceeds maxItemModelDepth=${host.maxItemModelDepth ?? DEFAULT_MAX_ITEM_MODEL_DEPTH}.`,
      node.range,
      context.sourceFile
    );
    return undefined;
  }

  switch (node.kind) {
    case "ItemModelExpr":
      return lowerItemModelExpression(node, context, host, generatedPath);
    case "ItemModelSelect":
      return lowerSelect(node, context, host, generatedPath, depth);
    case "ItemModelRange":
      return lowerRange(node, context, host, generatedPath, depth);
    case "ItemModelCondition":
      return lowerCondition(node, context, host, generatedPath, depth);
    case "ItemModelComposite":
      return lowerComposite(node, context, host, generatedPath, depth);
    case "ItemModelSpecial":
      return lowerItemModelSpecial(node, context, host, generatedPath);
    case "ItemModelFirstMatch":
      return lowerFirstMatch(node, context, host, generatedPath, depth);
    case "ItemModelEmpty":
      return terminalModel("minecraft:empty", node.range, context, generatedPath);
    case "ItemModelSelectedItem":
      return terminalModel("minecraft:bundle/selected_item", node.range, context, generatedPath);
    case "ItemModelUse":
      return executeItemModelUseExpression(node.expression, node.range, context, host, generatedPath, depth);
    default:
      return assertNever(node);
  }
}

/** Executes an `-> item_model` template and enforces its cardinality-one contract. */
export function executeItemModelTemplateBody(
  body: ItemModelTemplateBodyNode,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath = "/model",
  depth = 0,
  callRange: TextRange = body.range,
  callFileName = context.sourceFile
): LoweredItemModel | undefined {
  const results: LoweredItemModel[] = [];
  let producerCount = 0;
  expandItemModelTemplateBody(
    body,
    childEvaluationContext(context, {}),
    host,
    (statement, statementContext) => {
      producerCount++;
      const lowered = statement.kind === "ItemModelProducerStmt"
        ? executeItemModelNode(statement.value, statementContext, host, generatedPath, depth)
        : executeItemModelUseExpression(
          statement.expression,
          statement.range,
          statementContext,
          host,
          generatedPath,
          depth
        );
      if (lowered) {
        results.push(lowered);
      }
    },
    generatedPath
  );
  if (producerCount !== 1) {
    const message = `An item_model template must produce exactly one item-model node; this path produced ${producerCount}.`;
    host.onError?.(
      "rsgl.itemModelTemplateCardinality",
      message,
      callRange,
      callFileName
    );
    host.onError?.(
      "rsgl.itemModelTemplateCardinalityDefinition",
      `This item_model template body produced ${producerCount} nodes for the selected call path; exactly one is required.`,
      body.range,
      context.sourceFile
    );
  }
  return results[0];
}

function lowerSelect(
  node: Extract<ItemModelNode, { kind: "ItemModelSelect" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const header = lowerPropertyHeader(node.property, node.propertyOptions, context, host, generatedPath);
  if (!header) {
    return undefined;
  }
  const cases: JsonValue[] = [];
  const mappings: ResourceBodyMapping[] = [nodeMapping(generatedPath, node.range, context), ...header.mappings];
  let fallback: Record<string, JsonValue> | undefined;
  let fallbackCount = 0;
  const seenWhen = new Set<string>();

  expandItemSelectBody(node.body, childEvaluationContext(context, {}), host, (statement, clauseContext) => {
    if (statement.kind === "ItemSelectCase") {
      const casePath = appendGeneratedPath(appendGeneratedPath(generatedPath, "cases"), String(cases.length));
      const when = evaluateCaptured(statement.when, clauseContext, host, appendGeneratedPath(casePath, "when"));
      const model = executeItemModelNode(
        statement.model,
        clauseContext,
        host,
        appendGeneratedPath(casePath, "model"),
        depth + 1
      );
      if (!when || !model) {
        return;
      }
      const whenKey = stableJsonKey(when.evaluated.value);
      if (seenWhen.has(whenKey)) {
        host.onWarning?.(
          "rsgl.duplicateItemSelectWhen",
          "A select body contains a duplicate case value at the same depth.",
          statement.when.range,
          clauseContext.sourceFile
        );
      }
      seenWhen.add(whenKey);
      commitCapturedObservations(host, when.observations, appendGeneratedPath(casePath, "when"), false);
      mappings.push(nodeMapping(casePath, statement.range, clauseContext));
      mappings.push(...expressionMappings(
        when.evaluated,
        statement.when.range,
        clauseContext,
        appendGeneratedPath(casePath, "when")
      ));
      mappings.push(...model.mappings);
      cases.push({ when: when.evaluated.value, model: model.value });
      return;
    }
    fallbackCount++;
    if (fallbackCount > 1) {
      host.onError?.(
        "rsgl.multipleItemFallbacks",
        "An item select body may contain at most one fallback.",
        statement.range,
        clauseContext.sourceFile
      );
      return;
    }
    const lowered = executeItemModelNode(
      statement.model,
      clauseContext,
      host,
      appendGeneratedPath(generatedPath, "fallback"),
      depth + 1
    );
    if (lowered) {
      fallback = lowered.value;
      mappings.push(...lowered.mappings);
    }
  }, generatedPath);

  const value: Record<string, JsonValue> = {
    type: "minecraft:select",
    property: header.property,
    ...header.options,
    cases
  };
  if (fallback) {
    value.fallback = fallback;
  }
  const result: MutableLowering = { value, mappings };
  applyPostfixOptions(result, node.options, ["transformation"], context, host, generatedPath);
  return result;
}

function lowerRange(
  node: Extract<ItemModelNode, { kind: "ItemModelRange" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const header = lowerPropertyHeader(node.property, node.propertyOptions, context, host, generatedPath);
  if (!header) {
    return undefined;
  }
  const entries: JsonValue[] = [];
  const mappings: ResourceBodyMapping[] = [nodeMapping(generatedPath, node.range, context), ...header.mappings];
  let fallback: Record<string, JsonValue> | undefined;
  let fallbackCount = 0;

  expandItemRangeBody(node.body, childEvaluationContext(context, {}), host, (statement, clauseContext) => {
    if (statement.kind === "ItemRangeEntry") {
      appendRangeEntry(
        entries,
        mappings,
        statement.threshold,
        statement.model,
        statement.range,
        clauseContext,
        host,
        generatedPath,
        depth
      );
      return;
    }
    if (statement.kind === "ItemRangeFrames") {
      appendRangeFrames(entries, mappings, statement, clauseContext, host, generatedPath, depth);
      return;
    }
    fallbackCount++;
    if (fallbackCount > 1) {
      host.onError?.(
        "rsgl.multipleItemFallbacks",
        "An item range body may contain at most one fallback.",
        statement.range,
        clauseContext.sourceFile
      );
      return;
    }
    const lowered = executeItemModelNode(
      statement.model,
      clauseContext,
      host,
      appendGeneratedPath(generatedPath, "fallback"),
      depth + 1
    );
    if (lowered) {
      fallback = lowered.value;
      mappings.push(...lowered.mappings);
    }
  }, generatedPath);

  const value: Record<string, JsonValue> = {
    type: "minecraft:range_dispatch",
    property: header.property,
    ...header.options,
    entries
  };
  if (fallback) {
    value.fallback = fallback;
  }
  const result: MutableLowering = { value, mappings };
  applyPostfixOptions(result, node.options, ["transformation"], context, host, generatedPath);
  return result;
}

function lowerCondition(
  node: Extract<ItemModelNode, { kind: "ItemModelCondition" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const header = lowerPropertyHeader(node.property, node.propertyOptions, context, host, generatedPath);
  const onTrue = node.onTrue
    ? executeItemModelNode(node.onTrue, context, host, appendGeneratedPath(generatedPath, "on_true"), depth + 1)
    : undefined;
  const onFalse = node.onFalse
    ? executeItemModelNode(node.onFalse, context, host, appendGeneratedPath(generatedPath, "on_false"), depth + 1)
    : undefined;
  if (!node.onTrue || !node.onFalse) {
    host.onError?.(
      "rsgl.compileMissingItemConditionBranch",
      "Item condition requires both on_true and on_false models.",
      node.range,
      context.sourceFile
    );
  }
  if (!header || !onTrue || !onFalse) {
    return undefined;
  }
  const result: MutableLowering = {
    value: {
      type: "minecraft:condition",
      property: header.property,
      ...header.options,
      on_true: onTrue.value,
      on_false: onFalse.value
    },
    mappings: [
      nodeMapping(generatedPath, node.range, context),
      ...header.mappings,
      ...onTrue.mappings,
      ...onFalse.mappings
    ]
  };
  applyPostfixOptions(result, node.options, ["transformation"], context, host, generatedPath);
  return result;
}

function lowerComposite(
  node: Extract<ItemModelNode, { kind: "ItemModelComposite" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const models: JsonValue[] = [];
  const mappings: ResourceBodyMapping[] = [nodeMapping(generatedPath, node.range, context)];
  expandItemCompositeBody(node.body, childEvaluationContext(context, {}), host, (statement, clauseContext) => {
    const childPath = appendGeneratedPath(appendGeneratedPath(generatedPath, "models"), String(models.length));
    const lowered = executeItemModelNode(statement.model, clauseContext, host, childPath, depth + 1);
    if (lowered) {
      models.push(lowered.value);
      mappings.push(...lowered.mappings);
    }
  }, generatedPath);
  if (models.length === 0) {
    host.onError?.(
      "rsgl.compileMissingItemCompositeModels",
      "Item composite must expand to at least one model.",
      node.range,
      context.sourceFile
    );
    return undefined;
  }
  const result: MutableLowering = {
    value: { type: "minecraft:composite", models },
    mappings
  };
  applyPostfixOptions(result, node.options, ["transformation"], context, host, generatedPath);
  return result;
}

function lowerFirstMatch(
  node: Extract<ItemModelNode, { kind: "ItemModelFirstMatch" }>,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const { whens, fallbacks } = collectItemFirstMatchClauses(
    node.body,
    childEvaluationContext(context, {}),
    host,
    generatedPath
  );
  if (whens.length === 0 || fallbacks.length !== 1) {
    host.onError?.(
      "rsgl.invalidItemFirstMatchCardinality",
      "first_match must expand to at least one when clause and exactly one fallback.",
      node.range,
      context.sourceFile
    );
    if (whens.length === 0 || fallbacks.length === 0) {
      return undefined;
    }
  }
  const loweredWhens: Array<{
    header: { property: string; options: Record<string, JsonValue> };
    onTrue: LoweredItemModel;
  }> = [];
  const mappings: ResourceBodyMapping[] = [nodeMapping(generatedPath, node.range, context)];
  const predicateKeys = new Set<string>();
  let conditionPath = generatedPath;
  for (let index = 0; index < whens.length; index++) {
    const clause = whens[index];
    const header = lowerPropertyHeader(
      clause.node.property,
      clause.node.propertyOptions,
      clause.context,
      host,
      conditionPath
    );
    const onTrue = executeItemModelNode(
      clause.node.model,
      clause.context,
      host,
      appendGeneratedPath(conditionPath, "on_true"),
      depth + index + 1
    );
    if (!header || !onTrue) {
      return undefined;
    }
    const predicateKey = stableJsonKey([header.property, header.options]);
    if (predicateKeys.has(predicateKey)) {
      host.onWarning?.(
        "rsgl.unreachableItemFirstMatchPredicate",
        "A first_match predicate duplicates an earlier predicate and may be unreachable.",
        clause.node.range,
        clause.context.sourceFile
      );
    }
    predicateKeys.add(predicateKey);
    mappings.push(nodeMapping(conditionPath, clause.node.range, clause.context));
    mappings.push(...header.mappings, ...onTrue.mappings);
    loweredWhens.push({
      header: { property: header.property, options: header.options },
      onTrue
    });
    conditionPath = appendGeneratedPath(conditionPath, "on_false");
  }

  const fallbackClause = fallbacks[0];
  const fallback = executeItemModelNode(
    fallbackClause.node.model,
    fallbackClause.context,
    host,
    conditionPath,
    depth + whens.length
  );
  if (!fallback) {
    return undefined;
  }
  mappings.push(...fallback.mappings);

  let value = fallback.value;
  for (let index = loweredWhens.length - 1; index >= 0; index--) {
    const clause = loweredWhens[index];
    value = {
      type: "minecraft:condition",
      property: clause.header.property,
      ...clause.header.options,
      on_true: clause.onTrue.value,
      on_false: value
    };
  }
  const result: MutableLowering = { value, mappings };
  applyPostfixOptions(result, node.options, ["transformation"], context, host, generatedPath);
  return result;
}

export function executeItemModelUseExpression(
  expression: ExprNode,
  callRange: TextRange,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): LoweredItemModel | undefined {
  const definition = host.resolveTemplate(expression, context);
  if (!definition) {
    host.onError?.(
      "rsgl.unknownTemplate",
      "Item-model use must expand a known template.",
      expression.range,
      context.sourceFile
    );
    return undefined;
  }
  const dispatch = host.resolveTemplateDispatch(definition, itemModelCallerContext);
  if (!dispatch.compatible || dispatch.selectedDialect !== "item_model") {
    return undefined;
  }
  const expansion = host.expandTemplate(expression, context, definition);
  if (!expansion) {
    return undefined;
  }
  if (definition.node.body.kind !== "ItemModelTemplateBody") {
    reportItemModelBodyMismatch(host, callRange, context, "item_model template");
    return undefined;
  }
  return executeItemModelTemplateBody(
    definition.node.body,
    expansion.context,
    host,
    generatedPath,
    depth,
    callRange,
    context.sourceFile
  );
}

function appendRangeEntry(
  entries: JsonValue[],
  mappings: ResourceBodyMapping[],
  thresholdExpression: ExprNode,
  modelNode: ItemModelNode,
  range: TextRange,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): void {
  const entryPath = appendGeneratedPath(appendGeneratedPath(generatedPath, "entries"), String(entries.length));
  const thresholdPath = appendGeneratedPath(entryPath, "threshold");
  const threshold = evaluateCaptured(thresholdExpression, context, host, thresholdPath);
  const model = executeItemModelNode(
    modelNode,
    context,
    host,
    appendGeneratedPath(entryPath, "model"),
    depth + 1
  );
  if (!threshold || typeof threshold.evaluated.value !== "number" || !Number.isFinite(threshold.evaluated.value) || !model) {
    if (threshold && (typeof threshold.evaluated.value !== "number" || !Number.isFinite(threshold.evaluated.value))) {
      host.onError?.(
        "rsgl.invalidItemRangeThreshold",
        "Item range entry threshold must evaluate to a finite number.",
        thresholdExpression.range,
        context.sourceFile
      );
    }
    return;
  }
  commitCapturedObservations(host, threshold.observations, thresholdPath, false);
  mappings.push(nodeMapping(entryPath, range, context));
  mappings.push(...expressionMappings(threshold.evaluated, thresholdExpression.range, context, thresholdPath));
  mappings.push(...model.mappings);
  entries.push({ threshold: threshold.evaluated.value, model: model.value });
}

function appendRangeFrames(
  entries: JsonValue[],
  mappings: ResourceBodyMapping[],
  statement: ItemRangeFramesNode,
  context: RsglCompileContext,
  host: ItemModelExecutorHost,
  generatedPath: string,
  depth: number
): void {
  let failed = false;
  const frameContext: RsglCompileContext = {
    ...context,
    onEvaluationFailure: () => {
      failed = true;
      context.onEvaluationFailure?.();
    }
  };
  const consumedBeforeEvaluation = frameContext.evaluationItemBudget?.consumed ?? 0;
  const result = evaluateExpressionResult(statement.frames, frameContext);
  if (failed) {
    host.onInvalidJsonValue?.();
    return;
  }
  if (!Array.isArray(result.value)) {
    host.onError?.(
      "rsgl.itemRangeFramesNonFinite",
      "Item range frames must evaluate to a finite list.",
      statement.frames.range,
      context.sourceFile
    );
    return;
  }
  if (!ensureEvaluationItemsForExpansion(
    frameContext,
    consumedBeforeEvaluation,
    result.value.length,
    statement.frames.range,
    `item range frames at '${appendGeneratedPath(generatedPath, "entries")}'`,
    (code, message, range, fileName) => host.onError?.(code, message, range, fileName)
  )) {
    return;
  }
  const origins = materializeEvaluationPathOrigins(result, context.sourceFile);
  const issues = materializeEvaluationValueIssues(result, context.sourceFile);
  for (const [index, frame] of result.value.entries()) {
    const loopContext = childEvaluationContext(context, { index, frame });
    const selectedPath = `/${index}`;
    const selectedOrigins = selectEvaluationPathOrigins(origins, selectedPath);
    bindEvaluationValue(
      loopContext,
      "frame",
      frame,
      originForEvaluationPath(selectedOrigins, ""),
      selectedOrigins,
      selectEvaluationValueIssues(issues, selectedPath)
    );
    const entryPath = appendGeneratedPath(appendGeneratedPath(generatedPath, "entries"), String(entries.length));
    const model = executeItemModelNode(
      statement.model,
      loopContext,
      host,
      appendGeneratedPath(entryPath, "model"),
      depth + 1
    );
    if (!model) {
      continue;
    }
    const threshold = typeof frame === "number" && Number.isFinite(frame) ? frame : index;
    const origin = originForEvaluationPath(selectedOrigins, "");
    mappings.push(nodeMapping(entryPath, statement.range, loopContext));
    mappings.push({
      generatedPath: appendGeneratedPath(entryPath, "threshold"),
      sourceRange: origin?.sourceRange ?? statement.frames.range,
      context: loopContext,
      ...(origin ? { validationOrigin: origin, validationOnly: true } : {})
    });
    mappings.push(...model.mappings);
    entries.push({ threshold, model: model.value });
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled item-model AST node: ${JSON.stringify(value)}`);
}
