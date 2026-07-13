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
  childEvaluationContext,
  expressionEvaluationPathOrigins
} from "./evaluate";
import { isJsonObject } from "./compilerHelpers";
import { JsonValue } from "./ir";
import { evaluateJsonExpression, type JsonValueSinkOptions } from "./jsonValueLowerer";
import type { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";

export type RsglItemFragmentOptions = JsonValueSinkOptions;

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
  options: RsglItemFragmentOptions = {}
): ResourceBodyFragment | undefined {
  let model: JsonValue | undefined;
  if (statement.kind === "ItemRangeStmt") {
    model = compileItemRangeStatement(statement, context, options);
  } else if (statement.kind === "ItemSelectStmt") {
    model = compileItemSelectStatement(statement, context, options);
  } else if (statement.kind === "ItemConditionStmt") {
    model = compileItemConditionStatement(statement, context, options);
  } else if (statement.kind === "ItemCompositeStmt") {
    model = compileItemCompositeStatement(statement, context, options);
  } else if (statement.kind === "ItemEmptyStmt") {
    model = { type: "minecraft:empty" };
  } else if (statement.kind === "ItemSelectedItemStmt") {
    model = { type: "minecraft:bundle/selected_item" };
  } else {
    model = compileItemSpecialStatementNode(statement, context, options);
  }
  return model === undefined
    ? undefined
    : {
      content: { model },
      mappings: itemFragmentValidationMappings(statement, context, model)
    };
}

function itemFragmentValidationMappings(
  statement: Parameters<typeof compileItemSpecialStatement>[0],
  context: EvaluationContext,
  model: JsonValue
): ResourceBodyMapping[] {
  const mappings: ResourceBodyMapping[] = [];
  const add = (expression: ExprNode | undefined, generatedPath: string) => {
    if (!expression) {
      return;
    }
    mappings.push(...expressionEvaluationPathOrigins(expression, context, generatedPath).map(origin => ({
      generatedPath: origin.generatedPath,
      sourceRange: expression.range,
      context,
      validationOrigin: origin,
      validationOnly: true
    })));
  };

  if (statement.kind === "ItemRangeStmt") {
    const entries = isJsonObject(model) && Array.isArray(model.entries) ? model.entries : [];
    entries.forEach((_, index) => add(
      statement.frames?.model,
      `/model/entries/${index}/model`
    ));
    add(statement.fallback, "/model/fallback");
  } else if (statement.kind === "ItemSelectStmt") {
    statement.cases.forEach((item, index) => add(item.model, `/model/cases/${index}/model`));
    add(statement.fallback, "/model/fallback");
  } else if (statement.kind === "ItemConditionStmt") {
    add(statement.onTrue, "/model/on_true");
    add(statement.onFalse, "/model/on_false");
  } else if (statement.kind === "ItemCompositeStmt") {
    statement.models.forEach((item, index) => add(item, `/model/models/${index}`));
  } else if (statement.kind === "ItemSpecialStmt") {
    add(statement.base, "/model/base");
    add(statement.model, "/model/model");
  }
  return mappings;
}

function compileItemRangeStatement(
  statement: ItemRangeStmtNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  if (!property || !statement.frames) {
    if (!statement.frames) {
      options.onError?.("rsgl.compileMissingItemRangeFrames", "Item range statement requires a frames clause.", statement.range);
    }
    return undefined;
  }

  const framesValue = evaluateJsonExpression(
    statement.frames.frames,
    context,
    options,
    "/model/entries"
  );
  if (framesValue === undefined) {
    return undefined;
  }
  if (!Array.isArray(framesValue)) {
    options.onError?.("rsgl.itemRangeFramesNonFinite", "Item range frames must evaluate to a finite list.", statement.frames.frames.range);
    return undefined;
  }

  const entries: JsonValue[] = [];
  for (const [index, frame] of framesValue.entries()) {
    const frameContext = childEvaluationContext(context, { index, frame });
    const frameModelValue = evaluateJsonExpression(
      statement.frames.model,
      frameContext,
      options,
      `/model/entries/${index}/model`
    );
    if (frameModelValue === undefined) {
      continue;
    }
    const model = normalizeItemModelDefinition(frameModelValue, context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item range frame model must evaluate to a model id or item model object.", statement.frames.model.range);
      continue;
    }
    entries.push({ threshold: defaultThreshold(frame, index), model });
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:range_dispatch",
    property,
    entries
  };
  copyStatementOptions(result, statement.options, context, ["component", "source", "target", "wobble", "scale"], options);

  const fallbackValue = statement.fallback
    ? evaluateJsonExpression(statement.fallback, context, options, "/model/fallback")
    : null;
  if (fallbackValue === undefined) {
    return undefined;
  }
  const fallback = fallbackValue === null
    ? null
    : normalizeItemModelDefinition(fallbackValue, context.namespace);
  if (fallback) {
    result.fallback = fallback;
  }
  return result;
}

function compileItemSelectStatement(
  statement: ItemSelectStmtNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  if (!property) {
    return undefined;
  }

  const cases: JsonValue[] = [];
  for (const [index, item] of statement.cases.entries()) {
    const casePath = `/model/cases/${index}`;
    const modelValue = evaluateJsonExpression(
      item.model,
      context,
      options,
      appendGeneratedPath(casePath, "model")
    );
    if (modelValue === undefined) {
      continue;
    }
    const model = normalizeItemModelDefinition(modelValue, context.namespace);
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

  const fallbackValue = statement.fallback
    ? evaluateJsonExpression(statement.fallback, context, options, "/model/fallback")
    : null;
  if (fallbackValue === undefined) {
    return undefined;
  }
  const fallback = fallbackValue === null
    ? null
    : normalizeItemModelDefinition(fallbackValue, context.namespace);
  if (fallback) {
    result.fallback = fallback;
  }
  return result;
}

function compileItemConditionStatement(
  statement: ItemConditionStmtNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options, "/model/property");
  const onTrueValue = statement.onTrue
    ? evaluateJsonExpression(statement.onTrue, context, options, "/model/on_true")
    : null;
  const onFalseValue = statement.onFalse
    ? evaluateJsonExpression(statement.onFalse, context, options, "/model/on_false")
    : null;
  if (onTrueValue === undefined || onFalseValue === undefined) {
    return undefined;
  }
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
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const models: JsonValue[] = [];
  for (const [index, item] of statement.models.entries()) {
    const modelValue = evaluateJsonExpression(
      item,
      context,
      options,
      `/model/models/${index}`
    );
    if (modelValue === undefined) {
      continue;
    }
    const model = normalizeItemModelDefinition(modelValue, context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item composite model must evaluate to a model id or item model object.", item.range);
      continue;
    }
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
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const base = expressionString(statement.base, context, "base", options, "/model/base");
  const model = evaluateJsonExpression(statement.model, context, options, "/model/model");
  if (model === undefined) {
    return undefined;
  }
  if (!base || !isJsonObject(model)) {
    if (!isJsonObject(model)) {
      options.onError?.("rsgl.invalidItemSpecialModel", "Item special model must evaluate to an object.", statement.model.range);
    }
    return undefined;
  }
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

function copyStatementOptions(
  target: Record<string, JsonValue>,
  statementOptions: ItemRangeStmtNode["options"] | ItemConditionStmtNode["options"],
  context: EvaluationContext,
  names: string[],
  options: RsglItemFragmentOptions
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

function defaultThreshold(frame: JsonValue, index: number): number {
  return typeof frame === "number" ? frame : index;
}

function expressionString(
  expression: ExprNode,
  context: EvaluationContext,
  name: string,
  options: RsglItemFragmentOptions,
  generatedPath: string
): string | null {
  const value = evaluateJsonExpression(expression, context, options, generatedPath);
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidItemFragmentArgument", `Item argument '${name}' must evaluate to a string.`, expression.range);
    return null;
  }
  return value;
}

function normalizeModelId(value: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `item/${value}`}`;
}
