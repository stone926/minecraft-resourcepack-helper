import {
  ExprNode,
  ItemCompositeStmtNode,
  ItemConditionStmtNode,
  ItemEmptyStmtNode,
  ItemRangeStmtNode,
  ItemSelectedItemStmtNode,
  ItemSelectStmtNode,
  ItemSpecialStmtNode,
  TextRange
} from "../parser";
import {
  EvaluationContext,
  EvaluationValue,
  childEvaluationContext,
  evaluateExpression,
  expressionEvaluationPathOrigins
} from "./evaluate";
import { isJsonObject, normalizeJsonValue } from "./compilerHelpers";
import { JsonValue } from "./ir";
import type { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";

export interface RsglItemFragmentOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
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

function normalizeItemModelDefinition(value: EvaluationValue, namespace: string): JsonValue | null {
  if (typeof value === "string") {
    return {
      type: "minecraft:model",
      model: normalizeModelId(value, namespace)
    };
  }
  if (isLambdaValue(value)) {
    return null;
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

function isLambdaValue(value: EvaluationValue): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: string }).kind === "lambda");
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
