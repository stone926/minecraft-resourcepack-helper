import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  IdentifierExprNode,
  ItemCompositeStmtNode,
  ItemConditionStmtNode,
  ItemEmptyStmtNode,
  ItemRangeStmtNode,
  ItemSelectedItemStmtNode,
  ItemSelectStmtNode,
  ItemSpecialStmtNode,
  TextRange,
  UseDeclNode
} from "../parser";
import {
  EvaluationContext,
  EvaluationValue,
  childEvaluationContext,
  evaluateExpression
} from "./evaluate";
import { isJsonObject, normalizeJsonValue } from "./compilerHelpers";
import { JsonValue } from "./ir";

export interface RsglItemFragmentOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

export function compileItemUseFragment(
  statement: UseDeclNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions = {}
): Record<string, JsonValue> | undefined {
  const call = itemFragmentCall(statement.expression);
  if (!call) {
    return undefined;
  }

  if (call.callee.name.text === "itemRangeFrames") {
    const model = compileItemRangeFrames(call, context, options);
    return model ? { model } : undefined;
  }
  if (call.callee.name.text === "itemSelectCases") {
    const model = compileItemSelectCases(call, context, options);
    return model ? { model } : undefined;
  }

  return undefined;
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
  options: RsglItemFragmentOptions = {}
): Record<string, JsonValue> | undefined {
  if (statement.kind === "ItemRangeStmt") {
    const model = compileItemRangeStatement(statement, context, options);
    return model ? { model } : undefined;
  }
  if (statement.kind === "ItemSelectStmt") {
    const model = compileItemSelectStatement(statement, context, options);
    return model ? { model } : undefined;
  }
  if (statement.kind === "ItemConditionStmt") {
    const model = compileItemConditionStatement(statement, context, options);
    return model ? { model } : undefined;
  }
  if (statement.kind === "ItemCompositeStmt") {
    const model = compileItemCompositeStatement(statement, context, options);
    return model ? { model } : undefined;
  }
  if (statement.kind === "ItemEmptyStmt") {
    return { model: { type: "minecraft:empty" } };
  }
  if (statement.kind === "ItemSelectedItemStmt") {
    return { model: { type: "minecraft:bundle/selected_item" } };
  }
  const model = compileItemSpecialStatementNode(statement, context, options);
  return model ? { model } : undefined;
}

function compileItemRangeFrames(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = stringArg(call, "property", 0, context, options);
  const framesArg = requiredArg(call, "frames", 1, options);
  const modelArg = requiredArg(call, "model", 2, options);
  if (!property || !framesArg || !modelArg) {
    return undefined;
  }

  const framesValue = normalizeJsonValue(evaluateExpression(framesArg.value, context));
  if (!Array.isArray(framesValue)) {
    options.onError?.("rsgl.itemRangeFramesNonFinite", "itemRangeFrames frames must evaluate to a finite list.", framesArg.value.range);
    return undefined;
  }

  const thresholdArg = findArg(call, "threshold", 3);
  const entries: JsonValue[] = [];
  for (const [index, frame] of framesValue.entries()) {
    const frameContext = childEvaluationContext(context, {
      index,
      frame
    });
    const thresholdValue = thresholdArg
      ? evaluateExpression(thresholdArg.value, frameContext)
      : defaultThreshold(frame, index);
    const threshold = Number(thresholdValue);
    if (!Number.isFinite(threshold)) {
      options.onError?.("rsgl.invalidItemRangeThreshold", "itemRangeFrames threshold must evaluate to a finite number.", thresholdArg?.value.range ?? framesArg.value.range);
      continue;
    }

    const model = normalizeItemModelDefinition(evaluateExpression(modelArg.value, frameContext), context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "itemRangeFrames model must evaluate to a model id or item model object.", modelArg.value.range);
      continue;
    }
    entries.push({ threshold, model });
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:range_dispatch",
    property,
    entries
  };
  copyOptionalArgs(result, call, context, ["component", "source", "target", "wobble", "scale"]);

  const fallback = optionalItemModelArg(call, "fallback", context);
  if (fallback) {
    result.fallback = fallback;
  }
  return result;
}

function compileItemRangeStatement(
  statement: ItemRangeStmtNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = expressionString(statement.property, context, "property", options);
  if (!property || !statement.frames) {
    if (!statement.frames) {
      options.onError?.("rsgl.compileMissingItemRangeFrames", "Item range statement requires a frames clause.", statement.range);
    }
    return undefined;
  }

  const framesValue = normalizeJsonValue(evaluateExpression(statement.frames.frames, context));
  if (!Array.isArray(framesValue)) {
    options.onError?.("rsgl.itemRangeFramesNonFinite", "Item range frames must evaluate to a finite list.", statement.frames.frames.range);
    return undefined;
  }

  const entries: JsonValue[] = [];
  for (const [index, frame] of framesValue.entries()) {
    const frameContext = childEvaluationContext(context, { index, frame });
    const model = normalizeItemModelDefinition(evaluateExpression(statement.frames.model, frameContext), context.namespace);
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
  copyStatementOptions(result, statement.options, context, ["component", "source", "target", "wobble", "scale"]);

  const fallback = statement.fallback
    ? normalizeItemModelDefinition(evaluateExpression(statement.fallback, context), context.namespace)
    : null;
  if (fallback) {
    result.fallback = fallback;
  }
  return result;
}

function compileItemSelectCases(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const property = stringArg(call, "property", 0, context, options);
  const casesArg = requiredArg(call, "cases", 1, options);
  if (!property || !casesArg) {
    return undefined;
  }

  const casesValue = normalizeJsonValue(evaluateExpression(casesArg.value, context));
  const cases = itemSelectCases(casesValue, context.namespace);
  if (!cases) {
    options.onError?.("rsgl.invalidItemSelectCases", "itemSelectCases cases must evaluate to an object or list of case objects.", casesArg.value.range);
    return undefined;
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:select",
    property,
    cases
  };
  copyOptionalArgs(result, call, context, ["component"]);

  const fallback = optionalItemModelArg(call, "fallback", context);
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
  const property = expressionString(statement.property, context, "property", options);
  if (!property) {
    return undefined;
  }

  const cases: JsonValue[] = [];
  for (const item of statement.cases) {
    const model = normalizeItemModelDefinition(evaluateExpression(item.model, context), context.namespace);
    if (!model) {
      options.onError?.("rsgl.invalidItemModel", "Item select case model must evaluate to a model id or item model object.", item.model.range);
      continue;
    }
    cases.push({
      when: normalizeJsonValue(evaluateExpression(item.when, context)),
      model
    });
  }

  const result: Record<string, JsonValue> = {
    type: "minecraft:select",
    property,
    cases
  };
  copyStatementOptions(result, statement.options, context, ["component"]);

  const fallback = statement.fallback
    ? normalizeItemModelDefinition(evaluateExpression(statement.fallback, context), context.namespace)
    : null;
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
  const property = expressionString(statement.property, context, "property", options);
  const onTrue = statement.onTrue
    ? normalizeItemModelDefinition(evaluateExpression(statement.onTrue, context), context.namespace)
    : null;
  const onFalse = statement.onFalse
    ? normalizeItemModelDefinition(evaluateExpression(statement.onFalse, context), context.namespace)
    : null;
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
  copyStatementOptions(result, statement.options, context, ["component", "ignore_default", "index", "keybind", "predicate", "value"]);
  return result;
}

function compileItemCompositeStatement(
  statement: ItemCompositeStmtNode,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): JsonValue | undefined {
  const models: JsonValue[] = [];
  for (const item of statement.models) {
    const model = normalizeItemModelDefinition(evaluateExpression(item, context), context.namespace);
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
  const base = expressionString(statement.base, context, "base", options);
  const model = normalizeJsonValue(evaluateExpression(statement.model, context));
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

function itemFragmentCall(expression: ExprNode): (CallExprNode & { callee: IdentifierExprNode }) | null {
  return expression.kind === "CallExpr" && expression.callee.kind === "IdentifierExpr"
    ? expression as CallExprNode & { callee: IdentifierExprNode }
    : null;
}

function itemSelectCases(value: JsonValue, namespace: string): JsonValue[] | null {
  if (isJsonObject(value)) {
    const cases: JsonValue[] = [];
    for (const [when, modelValue] of Object.entries(value)) {
      const model = normalizeItemModelDefinition(modelValue, namespace);
      if (model) {
        cases.push({ when, model });
      }
    }
    return cases;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const cases: JsonValue[] = [];
  for (const item of value) {
    const itemObject = isJsonObject(item) ? item : null;
    if (!itemObject || !("when" in itemObject) || !("model" in itemObject)) {
      return null;
    }
    const model = normalizeItemModelDefinition(itemObject.model, namespace);
    if (!model) {
      return null;
    }
    cases.push({ ...itemObject, model });
  }
  return cases;
}

function normalizeItemModelDefinition(value: EvaluationValue, namespace: string): JsonValue | null {
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

function optionalItemModelArg(
  call: CallExprNode,
  name: string,
  context: EvaluationContext
): JsonValue | null {
  const arg = findArg(call, name);
  return arg ? normalizeItemModelDefinition(evaluateExpression(arg.value, context), context.namespace) : null;
}

function copyOptionalArgs(
  target: Record<string, JsonValue>,
  call: CallExprNode,
  context: EvaluationContext,
  names: string[]
): void {
  for (const name of names) {
    const arg = findArg(call, name);
    if (!arg) {
      continue;
    }
    const value = evaluateExpression(arg.value, context);
    if (value !== undefined) {
      target[name] = normalizeJsonValue(value);
    }
  }
}

function copyStatementOptions(
  target: Record<string, JsonValue>,
  options: ItemRangeStmtNode["options"] | ItemConditionStmtNode["options"],
  context: EvaluationContext,
  names: string[]
): void {
  for (const option of options) {
    if (!names.includes(option.name.text)) {
      continue;
    }
    const value = evaluateExpression(option.value, context);
    if (value !== undefined) {
      target[option.name.text] = normalizeJsonValue(value);
    }
  }
}

function stringArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglItemFragmentOptions
): string | null {
  const arg = requiredArg(call, name, positionalIndex, options);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidItemFragmentArgument", `Item fragment argument '${name}' must evaluate to a string.`, arg.value.range);
    return null;
  }
  return value;
}

function requiredArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  options: RsglItemFragmentOptions
): ArgumentNode | null {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    options.onError?.("rsgl.compileMissingArgument", `Missing item fragment argument '${name}'.`, call.range);
  }
  return arg ?? null;
}

function findArg(call: CallExprNode, name: string, positionalIndex?: number): ArgumentNode | undefined {
  return call.args.find(arg => arg.name?.text === name)
    ?? (positionalIndex === undefined ? undefined : call.args.filter(arg => !arg.name)[positionalIndex]);
}

function defaultThreshold(frame: JsonValue, index: number): number {
  return typeof frame === "number" ? frame : index;
}

function expressionString(
  expression: ExprNode,
  context: EvaluationContext,
  name: string,
  options: RsglItemFragmentOptions
): string | null {
  const value = evaluateExpression(expression, context);
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
