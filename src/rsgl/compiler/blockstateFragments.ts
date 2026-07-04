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
import { JsonValue } from "./ir";
import {
  createDoorBlockstateContent,
  createFenceBlockstateContent,
  createFenceGateBlockstateContent,
  createSlabBlockstateContent,
  createStairsBlockstateContent,
  createTrapdoorBlockstateContent,
  createWallBlockstateContent
} from "./templates";

export interface RsglBlockstateFragment {
  variants?: Record<string, JsonValue>;
  multipart?: JsonValue[];
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
      uvlock: optionalBooleanArgument(expression, "uvlock", context)
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

  return {};
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

function optionalBooleanArgument(
  expression: CallExprNode,
  name: string,
  context: EvaluationContext
): boolean | undefined {
  const argument = expression.args.find(item => item.name?.text === name);
  if (!argument) {
    return undefined;
  }
  return Boolean(evaluateExpression(argument.value, context));
}

function callArgument(expression: CallExprNode, name: string, positionalIndex: number): CallExprNode["args"][number] | undefined {
  return expression.args.find(item => item.name?.text === name)
    ?? expression.args.filter(item => !item.name)[positionalIndex];
}

function staticText(expression: ExprNode, context: EvaluationContext): string | null {
  const value = evaluateExpression(expression, context);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
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
