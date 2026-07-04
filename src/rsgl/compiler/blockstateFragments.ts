import {
  CallExprNode,
  ExprNode,
  UseDeclNode
} from "../parser";
import {
  EvaluationContext,
  EvaluationValue,
  evaluateExpression
} from "./evaluate";
import { blockstateVariantKey } from "./blockstateKeys";
import { JsonValue, RsglMapping } from "./ir";
import {
  createAxisRotatedBlockstateContent,
  createDoorBlockstateContent,
  createFenceBlockstateContent,
  createFenceGateBlockstateContent,
  createHorizontalFacingBlockstateContent,
  createPaneBlockstateContent,
  createSlabBlockstateContent,
  createStairsBlockstateContent,
  createTrapdoorBlockstateContent,
  createWallBlockstateContent
} from "./templates";

export interface RsglBlockstateFragment {
  variants?: Record<string, JsonValue>;
  multipart?: JsonValue[];
  mappings?: RsglMapping[];
}

export interface RsglBlockstateValueFragment {
  handled: boolean;
  value: JsonValue;
}

export interface RsglBlockstateFragmentOptions {
  onError?: (code: string, message: string, range: { start: number; end: number }) => void;
}

export function compileBlockstateUseFragment(
  statement: UseDeclNode,
  context: EvaluationContext,
  options: RsglBlockstateFragmentOptions = {}
): RsglBlockstateFragment {
  const expression = statement.expression;
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return {};
  }

  if (expression.callee.name.text === "stairs") {
    return createStairsBlockstateContent({
      base: requiredModelArgument(expression, "base", 0, context, options),
      inner: requiredModelArgument(expression, "inner", 1, context, options),
      outer: requiredModelArgument(expression, "outer", 2, context, options),
      uvlock: optionalBooleanArgument(expression, "uvlock", 3, context)
    });
  }
  if (expression.callee.name.text === "slab") {
    return createSlabBlockstateContent({
      bottom: requiredModelArgument(expression, "bottom", 0, context, options),
      top: requiredModelArgument(expression, "top", 1, context, options),
      double: requiredModelArgument(expression, "double", 2, context, options)
    });
  }
  if (expression.callee.name.text === "fence") {
    return createFenceBlockstateContent({
      post: requiredModelArgument(expression, "post", 0, context, options),
      side: requiredModelArgument(expression, "side", 1, context, options)
    });
  }
  if (expression.callee.name.text === "fenceGate") {
    return createFenceGateBlockstateContent({
      base: requiredModelArgument(expression, "base", 0, context, options),
      open: requiredModelArgument(expression, "open", 1, context, options),
      wall: requiredModelArgument(expression, "wall", 2, context, options),
      wallOpen: requiredModelArgument(expression, "wallOpen", 3, context, options)
    });
  }
  if (expression.callee.name.text === "door") {
    return createDoorBlockstateContent({
      bottomLeft: requiredModelArgument(expression, "bottomLeft", 0, context, options),
      bottomLeftOpen: requiredModelArgument(expression, "bottomLeftOpen", 1, context, options),
      bottomRight: requiredModelArgument(expression, "bottomRight", 2, context, options),
      bottomRightOpen: requiredModelArgument(expression, "bottomRightOpen", 3, context, options),
      topLeft: requiredModelArgument(expression, "topLeft", 4, context, options),
      topLeftOpen: requiredModelArgument(expression, "topLeftOpen", 5, context, options),
      topRight: requiredModelArgument(expression, "topRight", 6, context, options),
      topRightOpen: requiredModelArgument(expression, "topRightOpen", 7, context, options)
    });
  }
  if (expression.callee.name.text === "trapdoor") {
    return createTrapdoorBlockstateContent({
      bottom: requiredModelArgument(expression, "bottom", 0, context, options),
      top: requiredModelArgument(expression, "top", 1, context, options),
      open: requiredModelArgument(expression, "open", 2, context, options)
    });
  }
  if (expression.callee.name.text === "wall") {
    return createWallBlockstateContent({
      post: requiredModelArgument(expression, "post", 0, context, options),
      side: requiredModelArgument(expression, "side", 1, context, options),
      sideTall: requiredModelArgument(expression, "sideTall", 2, context, options)
    });
  }
  if (expression.callee.name.text === "pane") {
    return createPaneBlockstateContent({
      post: requiredModelArgument(expression, "post", 0, context, options),
      side: requiredModelArgument(expression, "side", 1, context, options),
      sideAlt: requiredModelArgument(expression, "sideAlt", 2, context, options),
      noSide: requiredModelArgument(expression, "noSide", 3, context, options),
      noSideAlt: requiredModelArgument(expression, "noSideAlt", 4, context, options)
    });
  }
  if (expression.callee.name.text === "horizontalFacing") {
    return createHorizontalFacingBlockstateContent({
      model: requiredModelArgument(expression, "model", 0, context, options),
      state: optionalStateArgument(expression, "state", 1, context, options, ["facing"]),
      uvlock: optionalBooleanArgument(expression, "uvlock", 2, context)
    });
  }
  if (expression.callee.name.text === "axisRotated") {
    return createAxisRotatedBlockstateContent({
      vertical: requiredModelArgument(expression, "vertical", 0, context, options),
      horizontal: requiredModelArgument(expression, "horizontal", 1, context, options),
      state: optionalStateArgument(expression, "state", 2, context, options, ["axis"]),
      uvlock: optionalBooleanArgument(expression, "uvlock", 3, context)
    });
  }
  if (expression.callee.name.text === "randomVariants") {
    const models = randomVariantEntries(expression, context, options);
    if (!models) {
      return {};
    }
    const stateArg = callArgument(expression, "state", 1);
    const state = stateArg ? normalizeJsonValue(evaluateExpression(stateArg.value, context)) : {};
    return {
      variants: {
        [blockstateVariantKey(state)]: models
      }
    };
  }

  return {};
}

export function compileBlockstateValueFragment(
  expression: ExprNode,
  context: EvaluationContext,
  options: RsglBlockstateFragmentOptions = {}
): RsglBlockstateValueFragment | null {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return null;
  }
  if (expression.callee.name.text !== "randomVariants") {
    return null;
  }
  return {
    handled: true,
    value: randomVariantEntries(expression, context, options) ?? []
  };
}

export function mergeBlockstateContent(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "variants" && isJsonObject(value)) {
      mergeBlockstateFragment(target, { variants: value }, range, options);
    } else if (key === "multipart" && Array.isArray(value)) {
      mergeBlockstateFragment(target, { multipart: value }, range, options);
    } else {
      target[key] = value;
    }
  }
}

export function mergeBlockstateFragment(
  target: Record<string, JsonValue>,
  fragment: RsglBlockstateFragment,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): void {
  if (fragment.variants) {
    if (target.multipart) {
      options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
      return;
    }
    const variants = isJsonObject(target.variants) ? target.variants : {};
    Object.assign(variants, fragment.variants);
    target.variants = variants;
  }
  if (fragment.multipart) {
    if (target.variants) {
      options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
      return;
    }
    const multipart = Array.isArray(target.multipart) ? target.multipart : [];
    multipart.push(...fragment.multipart);
    target.multipart = multipart;
  }
}

function requiredModelArgument(
  expression: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglBlockstateFragmentOptions
): string {
  const argument = callArgument(expression, name, positionalIndex);
  const value = argument ? staticText(argument.value, context) : null;
  if (!value) {
    options.onError?.("rsgl.compileMissingArgument", `Missing template argument '${name}'.`, expression.range);
    return "";
  }
  return normalizeBlockModelValue(value, context.namespace);
}

function randomVariantEntries(
  expression: CallExprNode,
  context: EvaluationContext,
  options: RsglBlockstateFragmentOptions
): JsonValue[] | null {
  const argument = callArgument(expression, "models", 0);
  if (!argument) {
    options.onError?.("rsgl.compileMissingArgument", "Missing template argument 'models'.", expression.range);
    return null;
  }
  const value = normalizeJsonValue(evaluateExpression(argument.value, context));
  if (!Array.isArray(value)) {
    options.onError?.("rsgl.invalidRandomVariantsArgument", "randomVariants models must evaluate to a finite list.", argument.value.range);
    return null;
  }

  const entries: JsonValue[] = [];
  for (const item of value) {
    const entry = normalizeRandomVariantEntry(item, context.namespace);
    if (!entry) {
      options.onError?.("rsgl.invalidRandomVariantEntry", "randomVariants entries must be model ids or model objects.", argument.value.range);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function normalizeRandomVariantEntry(value: JsonValue, namespace: string): JsonValue | null {
  if (typeof value === "string") {
    return { model: normalizeBlockModelValue(value, namespace) };
  }
  if (!isJsonObject(value)) {
    return null;
  }
  if (typeof value.model === "string") {
    return {
      ...value,
      model: normalizeBlockModelValue(value.model, namespace)
    };
  }
  return null;
}

function optionalBooleanArgument(
  expression: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext
): boolean | undefined {
  const argument = callArgument(expression, name, positionalIndex);
  if (!argument) {
    return undefined;
  }
  return Boolean(evaluateExpression(argument.value, context));
}

function optionalStateArgument(
  expression: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglBlockstateFragmentOptions,
  reservedKeys: string[]
): Record<string, JsonValue> | undefined {
  const argument = callArgument(expression, name, positionalIndex);
  if (!argument) {
    return undefined;
  }
  const value = normalizeJsonValue(evaluateExpression(argument.value, context));
  if (!isJsonObject(value)) {
    options.onError?.("rsgl.invalidTemplateStateArgument", `Template argument '${name}' must evaluate to an object.`, argument.value.range);
    return undefined;
  }
  for (const key of reservedKeys) {
    if (Object.hasOwn(value, key)) {
      options.onError?.("rsgl.templateStateConflict", `Template argument '${name}' must not define '${key}'.`, argument.value.range);
    }
  }
  return value;
}

function callArgument(expression: CallExprNode, name: string, positionalIndex: number): CallExprNode["args"][number] | undefined {
  return expression.args.find(item => item.name?.text === name)
    ?? expression.args.filter(item => !item.name)[positionalIndex];
}

function staticText(expression: ExprNode, context: EvaluationContext): string | null {
  const value = evaluateExpression(expression, context);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}

function normalizeBlockModelValue(value: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `block/${value}`}`;
}

function isJsonObject(value: EvaluationValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
