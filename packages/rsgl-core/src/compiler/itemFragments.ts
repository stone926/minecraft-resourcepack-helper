import {
  ExprNode,
  ItemCompositeStmtNode,
  ItemConditionStmtNode,
  ItemEmptyStmtNode,
  ItemRangeStmtNode,
  ItemSelectedItemStmtNode,
  ItemSelectStmtNode,
  ItemSpecialStmtNode
} from "../parser";
import {
  EvaluationContext,
  type EvaluationResult,
  bindEvaluationValue,
  childEvaluationContext,
  evaluateExpressionResult,
  materializeEvaluationPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath,
  selectEvaluationPathOrigins,
  selectEvaluationValueIssues
} from "./evaluate";
import { evaluatedPathOrigins } from "./evaluationProvenance";
import { isJsonObject } from "./jsonValues";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import { JsonValue } from "./ir";
import {
  evaluateJsonExpression,
  evaluateJsonExpressionWithResult,
  type JsonValueSinkOptions
} from "./jsonValueLowerer";
import type { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";

interface ItemModelSinkMapping {
  readonly result: EvaluationResult;
  readonly sourceRange: ExprNode["range"];
  readonly generatedPath: string;
}

export function compileItemSpecialStatement(
  statement:
    | ItemRangeStmtNode
    | ItemSelectStmtNode
    | ItemConditionStmtNode
    | ItemCompositeStmtNode
    | ItemEmptyStmtNode
    | ItemSelectedItemStmtNode
    | ItemSpecialStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions = {}
): ResourceBodyFragment | undefined {
  let model: JsonValue | undefined;
  const modelSinkMappings: ItemModelSinkMapping[] = [];
  if (statement.kind === "ItemRangeStmt") {
    model = compileItemRangeStatement(statement, context, options, modelSinkMappings);
  } else if (statement.kind === "ItemSelectStmt") {
    model = compileItemSelectStatement(statement, context, options, modelSinkMappings);
  } else if (statement.kind === "ItemConditionStmt") {
    model = compileItemConditionStatement(statement, context, options, modelSinkMappings);
  } else if (statement.kind === "ItemCompositeStmt") {
    model = compileItemCompositeStatement(statement, context, options, modelSinkMappings);
  } else if (statement.kind === "ItemEmptyStmt") {
    model = { type: "minecraft:empty" };
  } else if (statement.kind === "ItemSelectedItemStmt") {
    model = { type: "minecraft:bundle/selected_item" };
  } else {
    model = compileItemSpecialStatementNode(statement, context, options, modelSinkMappings);
  }
  return model === undefined
    ? undefined
    : {
      content: { model },
      mappings: itemFragmentValidationMappings(context, modelSinkMappings)
    };
}

function itemFragmentValidationMappings(
  context: EvaluationContext,
  modelSinkMappings: readonly ItemModelSinkMapping[]
): ResourceBodyMapping[] {
  return modelSinkMappings.flatMap(item =>
    evaluatedPathOrigins(item.result, item.generatedPath).map(origin => ({
      generatedPath: origin.generatedPath,
      sourceRange: item.sourceRange,
      context,
      validationOrigin: origin,
      validationOnly: true
    }))
  );
}

function compileItemRangeStatement(
  statement: ItemRangeStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  modelSinkMappings: ItemModelSinkMapping[]
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  if (!property || !statement.frames) {
    if (!statement.frames) {
      options.onError?.("rsgl.compileMissingItemRangeFrames", "Item range statement requires a frames clause.", statement.range);
    }
    return undefined;
  }

  let evaluationFailed = false;
  const framesContext: EvaluationContext = {
    ...context,
    onEvaluationFailure: () => {
      evaluationFailed = true;
      context.onEvaluationFailure?.();
    }
  };
  const framesResult = evaluateExpressionResult(statement.frames.frames, framesContext);
  const framesValue = framesResult.value;
  if (evaluationFailed) {
    options.onInvalidJsonValue?.();
    return undefined;
  }
  if (framesValue === undefined) {
    return undefined;
  }
  if (!Array.isArray(framesValue)) {
    options.onError?.("rsgl.itemRangeFramesNonFinite", "Item range frames must evaluate to a finite list.", statement.frames.frames.range);
    return undefined;
  }

  const entries: JsonValue[] = [];
  const frameOrigins = materializeEvaluationPathOrigins(framesResult, context.sourceFile);
  const frameIssues = materializeEvaluationValueIssues(framesResult, context.sourceFile);
  for (const [index, frame] of framesValue.entries()) {
    const frameContext = childEvaluationContext(context, { index, frame });
    const selectedPath = `/${index}`;
    const selectedOrigins = selectEvaluationPathOrigins(frameOrigins, selectedPath);
    bindEvaluationValue(
      frameContext,
      "frame",
      frame,
      originForEvaluationPath(selectedOrigins, ""),
      selectedOrigins,
      selectEvaluationValueIssues(frameIssues, selectedPath)
    );
    const modelPath = `/model/entries/${entries.length}/model`;
    const evaluatedFrameModel = evaluateJsonExpressionWithResult(
      statement.frames.model,
      frameContext,
      options,
      modelPath
    );
    if (!evaluatedFrameModel) {
      continue;
    }
    const model = normalizeItemModelDefinition(evaluatedFrameModel.value, context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item range frame model must evaluate to a model id or item model object.", statement.frames.model.range);
      continue;
    }
    modelSinkMappings.push({
      result: evaluatedFrameModel.result,
      sourceRange: statement.frames.model.range,
      generatedPath: modelPath
    });
    entries.push({ threshold: defaultThreshold(frame, index), model });
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:range_dispatch",
    property,
    entries
  };
  copyStatementOptions(result, statement.options, context, ["component", "source", "target", "wobble", "scale"], options);

  const evaluatedFallback = statement.fallback
    ? evaluateJsonExpressionWithResult(statement.fallback, context, options, "/model/fallback")
    : undefined;
  if (statement.fallback && !evaluatedFallback) {
    return undefined;
  }
  const fallbackValue = evaluatedFallback?.value ?? null;
  const fallback = fallbackValue === null
    ? null
    : normalizeItemModelDefinition(fallbackValue, context.namespace);
  if (fallback) {
    modelSinkMappings.push({
      result: evaluatedFallback!.result,
      sourceRange: statement.fallback!.range,
      generatedPath: "/model/fallback"
    });
    result.fallback = fallback;
  }
  return result;
}

function compileItemSelectStatement(
  statement: ItemSelectStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  modelSinkMappings: ItemModelSinkMapping[]
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  if (!property) {
    return undefined;
  }

  const cases: JsonValue[] = [];
  for (const item of statement.cases) {
    const casePath = `/model/cases/${cases.length}`;
    const evaluatedModel = evaluateJsonExpressionWithResult(
      item.model,
      context,
      options,
      appendGeneratedPath(casePath, "model")
    );
    if (!evaluatedModel) {
      continue;
    }
    const model = normalizeItemModelDefinition(evaluatedModel.value, context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item select case model must evaluate to a model id or item model object.", item.model.range);
      continue;
    }
    const when = evaluateJsonExpression(
      item.when,
      context,
      options,
      appendGeneratedPath(casePath, "when")
    );
    if (when === undefined) {
      continue;
    }
    modelSinkMappings.push({
      result: evaluatedModel.result,
      sourceRange: item.model.range,
      generatedPath: appendGeneratedPath(casePath, "model")
    });
    cases.push({
      when,
      model
    });
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:select",
    property,
    cases
  };
  copyStatementOptions(result, statement.options, context, ["component"], options);

  const evaluatedFallback = statement.fallback
    ? evaluateJsonExpressionWithResult(statement.fallback, context, options, "/model/fallback")
    : undefined;
  if (statement.fallback && !evaluatedFallback) {
    return undefined;
  }
  const fallbackValue = evaluatedFallback?.value ?? null;
  const fallback = fallbackValue === null
    ? null
    : normalizeItemModelDefinition(fallbackValue, context.namespace);
  if (fallback) {
    modelSinkMappings.push({
      result: evaluatedFallback!.result,
      sourceRange: statement.fallback!.range,
      generatedPath: "/model/fallback"
    });
    result.fallback = fallback;
  }
  return result;
}

function compileItemConditionStatement(
  statement: ItemConditionStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  modelSinkMappings: ItemModelSinkMapping[]
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  const evaluatedOnTrue = statement.onTrue
    ? evaluateJsonExpressionWithResult(statement.onTrue, context, options, "/model/on_true")
    : undefined;
  const evaluatedOnFalse = statement.onFalse
    ? evaluateJsonExpressionWithResult(statement.onFalse, context, options, "/model/on_false")
    : undefined;
  if ((statement.onTrue && !evaluatedOnTrue) || (statement.onFalse && !evaluatedOnFalse)) {
    return undefined;
  }
  const onTrueValue = evaluatedOnTrue?.value ?? null;
  const onFalseValue = evaluatedOnFalse?.value ?? null;
  const onTrue = onTrueValue === null ? null : normalizeItemModelDefinition(onTrueValue, context.namespace);
  const onFalse = onFalseValue === null ? null : normalizeItemModelDefinition(onFalseValue, context.namespace);
  if (!property || !onTrue || !onFalse) {
    if (!onTrue) {
      options.onError?.("rsgl.compileMissingItemConditionBranch", "Item condition statement requires an on_true model.", statement.range);
    }
    if (!onFalse) {
      options.onError?.("rsgl.compileMissingItemConditionBranch", "Item condition statement requires an on_false model.", statement.range);
    }
    return undefined;
  }

  modelSinkMappings.push(
    {
      result: evaluatedOnTrue!.result,
      sourceRange: statement.onTrue!.range,
      generatedPath: "/model/on_true"
    },
    {
      result: evaluatedOnFalse!.result,
      sourceRange: statement.onFalse!.range,
      generatedPath: "/model/on_false"
    }
  );

  const result: Record<string, JsonValue> = {
    type: "minecraft:condition",
    property,
    ["on_true"]: onTrue,
    ["on_false"]: onFalse
  };
  copyStatementOptions(result, statement.options, context, ["component", "ignore_default", "index", "keybind", "predicate", "value"], options);
  return result;
}

function compileItemCompositeStatement(
  statement: ItemCompositeStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  modelSinkMappings: ItemModelSinkMapping[]
): JsonValue | undefined {
  const models: JsonValue[] = [];
  for (const item of statement.models) {
    const modelPath = `/model/models/${models.length}`;
    const captured = evaluateJsonExpressionWithResourceValues(
      item,
      context,
      options,
      modelPath
    );
    const modelValue = captured.value;
    if (modelValue === undefined) {
      continue;
    }
    const model = normalizeItemModelDefinition(modelValue, context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item composite model must evaluate to a model id or item model object.", item.range);
      continue;
    }
    const scalarModel = typeof modelValue === "string";
    commitItemModelResourceValues(
      options,
      captured.observations,
      modelPath,
      scalarModel
    );
    modelSinkMappings.push({
      result: captured.result!,
      sourceRange: item.range,
      generatedPath: scalarModel ? appendGeneratedPath(modelPath, "model") : modelPath
    });
    models.push(model);
  }
  if (models.length === 0) {
    options.onError?.("rsgl.compileMissingItemCompositeModels", "Item composite statement requires at least one model.", statement.range);
    return undefined;
  }
  return {
    type: "minecraft:composite",
    models
  };
}

function compileItemSpecialStatementNode(
  statement: ItemSpecialStmtNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  modelSinkMappings: ItemModelSinkMapping[]
): JsonValue | undefined {
  const evaluatedBase = expressionStringWithResult(
    statement.base,
    context,
    "base",
    options,
    "/model/base"
  );
  const evaluatedModel = evaluateJsonExpressionWithResult(
    statement.model,
    context,
    options,
    "/model/model"
  );
  if (!evaluatedModel) {
    return undefined;
  }
  const model = evaluatedModel.value;
  const base = evaluatedBase?.value ?? null;
  if (!base || !isJsonObject(model)) {
    if (!isJsonObject(model)) {
      options.onError?.("rsgl.invalidItemSpecialModel", "Item special model must evaluate to an object.", statement.model.range);
    }
    return undefined;
  }
  modelSinkMappings.push(
    {
      result: evaluatedBase!.result,
      sourceRange: statement.base.range,
      generatedPath: "/model/base"
    },
    {
      result: evaluatedModel.result,
      sourceRange: statement.model.range,
      generatedPath: "/model/model"
    }
  );
  return {
    type: "minecraft:special",
    base: normalizeModelId(base, context.namespace),
    model
  };
}

function normalizeItemModelDefinition(value: JsonValue, namespace: string): JsonValue | null {
  if (typeof value === "string") {
    return {
      type: "minecraft:model",
      model: normalizeModelId(value, namespace)
    };
  }
  const object = isJsonObject(value) ? value : null;
  if (!object) {
    return null;
  }
  if ("type" in object) {
    return object;
  }
  if (typeof object.model === "string") {
    return {
      ...object,
      type: "minecraft:model",
      model: normalizeModelId(object.model, namespace)
    };
  }
  return object;
}

function evaluateJsonExpressionWithResourceValues(
  expression: ExprNode,
  context: EvaluationContext,
  options: JsonValueSinkOptions,
  generatedPath: string
): {
  value: JsonValue | undefined;
  result: EvaluationResult | undefined;
  observations: RsglResourceValueObservation[];
} {
  const observations: RsglResourceValueObservation[] = [];
  const evaluated = evaluateJsonExpressionWithResult(
    expression,
    context,
    {
      ...options,
      onResourceValueObservation: observation => observations.push(observation)
    },
    generatedPath
  );
  return { value: evaluated?.value, result: evaluated?.result, observations };
}

function commitItemModelResourceValues(
  options: JsonValueSinkOptions,
  observations: readonly RsglResourceValueObservation[],
  modelPath: string,
  scalarModel: boolean
): void {
  const observe = options.onResourceValueObservation;
  if (!observe) {
    return;
  }
  observations.forEach(observation => observe(
    scalarModel && observation.generatedPath === modelPath
      ? { ...observation, generatedPath: appendGeneratedPath(modelPath, "model") }
      : observation
  ));
}

function copyStatementOptions(
  target: Record<string, JsonValue>,
  statementOptions: ItemRangeStmtNode["options"] | ItemConditionStmtNode["options"],
  context: EvaluationContext,
  names: string[],
  options: JsonValueSinkOptions
): void {
  for (const option of statementOptions) {
    if (!names.includes(option.name.text)) {
      continue;
    }
    const value = evaluateJsonExpression(
      option.value,
      context,
      options,
      appendGeneratedPath("/model", option.name.text)
    );
    if (value !== undefined) {
      target[option.name.text] = value;
    }
  }
}

function defaultThreshold(frame: unknown, index: number): number {
  return typeof frame === "number" ? frame : index;
}

function expressionString(
  expression: ExprNode,
  context: EvaluationContext,
  name: string,
  options: JsonValueSinkOptions,
  generatedPath: string
): string | null {
  return expressionStringWithResult(expression, context, name, options, generatedPath)?.value ?? null;
}

function expressionStringWithResult(
  expression: ExprNode,
  context: EvaluationContext,
  name: string,
  options: JsonValueSinkOptions,
  generatedPath: string
): { value: string; result: EvaluationResult } | null {
  const evaluated = evaluateJsonExpressionWithResult(expression, context, options, generatedPath);
  if (!evaluated) {
    return null;
  }
  const { value } = evaluated;
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidItemFragmentArgument", `Item argument '${name}' must evaluate to a string.`, expression.range);
    return null;
  }
  return { value, result: evaluated.result };
}

function normalizeModelId(value: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `item/${value}`}`;
}
