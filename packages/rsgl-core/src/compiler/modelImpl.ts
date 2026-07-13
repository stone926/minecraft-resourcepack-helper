import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  ResourceDeclNode,
  TextRange
} from "../parser";
import { isJsonObject } from "./compilerHelpers";
import {
  EvaluationContext,
  type EvaluationOrigin,
  evaluateExpression,
  expressionEvaluationOrigin
} from "./evaluate";
import {
  evaluationScalarText,
  isEvaluatedResourceId,
  isEvaluatedTextureVariable
} from "./evaluatedResourceValues";
import { JsonValue, RsglMapping } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { normalizeResourceValue } from "./templates";
import { typeKindForResourceValueKind } from "../resourceIdSemantics";

export interface ModelImplOptions {
  onError: (code: string, message: string, range: TextRange) => void;
  createMapping: (
    generatedPath: string,
    sourceRange: TextRange,
    validationOrigin?: EvaluationOrigin
  ) => RsglMapping;
}

export interface ModelImplBody {
  content: Record<string, JsonValue>;
  mappings: RsglMapping[];
}

interface ModelImplData {
  parent: string;
  parentRange: TextRange;
  parentOrigin?: EvaluationOrigin;
  implRange: TextRange;
  textures: Map<string, { value: string; range: TextRange; origin?: EvaluationOrigin }>;
}

/**
 * Merges a `model ... impl parent(slot: texture, ...)` clause into the compiled
 * resource body. The impl parent always wins; body texture slots override impl
 * slots. Returned mappings cover the injected `/parent` and `/textures/<slot>`
 * fields and drop body mappings for fields the impl discards.
 */
export function applyModelImpl(
  statement: ResourceDeclNode,
  subtype: string,
  body: ModelImplBody,
  context: EvaluationContext,
  options: ModelImplOptions
): ModelImplBody {
  if (!statement.impl) {
    return body;
  }
  const impl = modelImplData(statement.impl, subtype, context, options.onError);
  if (!impl) {
    return body;
  }
  if (Object.hasOwn(body.content, "parent")) {
    options.onError("rsgl.duplicateModelParent", "Model body must not declare 'parent' when using impl.", statement.impl.range);
  }
  const { textures: bodyTextures, ...rest } = body.content;
  delete rest.parent;
  const bodyTextureSlots = isJsonObject(bodyTextures) ? bodyTextures : {};
  const implTextures: Record<string, JsonValue> = {};
  for (const [slot, texture] of impl.textures) {
    implTextures[slot] = texture.value;
  }
  const mergedTextures: Record<string, JsonValue> = {
    ...implTextures,
    ...bodyTextureSlots
  };
  const content: Record<string, JsonValue> = {
    parent: impl.parent,
    ...(Object.keys(mergedTextures).length > 0 ? { textures: mergedTextures } : {}),
    ...rest
  };
  return { content, mappings: modelImplMappings(impl, body.mappings, bodyTextureSlots, options) };
}

function modelImplMappings(
  impl: ModelImplData,
  bodyMappings: RsglMapping[],
  bodyTextureSlots: Record<string, JsonValue>,
  options: ModelImplOptions
): RsglMapping[] {
  // The body's parent field is discarded in favor of the impl parent, so its
  // mapping must not survive; body texture overrides keep their own mappings.
  const retainedBodyMappings = bodyMappings.filter(mapping => mapping.generatedPath !== "/parent");
  const bodyPaths = new Set(retainedBodyMappings.map(mapping => mapping.generatedPath));
  const mappings: RsglMapping[] = [options.createMapping("/parent", impl.parentRange, impl.parentOrigin)];
  if (impl.textures.size > 0 && !bodyPaths.has("/textures")) {
    mappings.push(options.createMapping("/textures", impl.implRange));
  }
  for (const [slot, texture] of impl.textures) {
    // Slot ownership is decided by the merged content, not by mapping
    // granularity: a body `textures <expr>` only maps "/textures" yet its
    // slots still win the merge, while stale granular mappings from replaced
    // Inline merge fragments must not veto the impl's rightful attribution.
    if (Object.hasOwn(bodyTextureSlots, slot)) {
      continue;
    }
    mappings.push(options.createMapping(
      appendGeneratedPath("/textures", slot),
      texture.range,
      texture.origin
    ));
  }
  return [...mappings, ...retainedBodyMappings];
}

function modelImplData(
  expression: ExprNode,
  subtype: string,
  context: EvaluationContext,
  onError: ModelImplOptions["onError"]
): ModelImplData | null {
  const call = expression.kind === "CallExpr" ? expression : undefined;
  const parentExpression = call?.callee ?? expression;
  const evaluatedParent = evaluateExpression(parentExpression, context);
  if (isEvaluatedTextureVariable(evaluatedParent)) {
    context.onResourceValueFailure?.();
    onError(
      "rsgl.resourceIdKindMismatch",
      "TextureVariable cannot be used where ModelId is required.",
      parentExpression.range
    );
    return null;
  }
  if (isEvaluatedResourceId(evaluatedParent) && evaluatedParent.resourceKind !== "model") {
    context.onResourceValueFailure?.();
    onError(
      "rsgl.resourceIdKindMismatch",
      `${typeKindForResourceValueKind(evaluatedParent.resourceKind)} cannot be used where ModelId is required.`,
      parentExpression.range
    );
    return null;
  }
  const parentValue = evaluationScalarText(evaluatedParent);
  if (!parentValue) {
    onError("rsgl.invalidModelImplParent", "Model impl parent must evaluate to a static model id.", parentExpression.range);
    return null;
  }
  if (parentValue.startsWith("#")) {
    onError(
      "rsgl.resourceReferenceExpected",
      `Texture variable '${parentValue}' cannot be used where ModelId is required.`,
      parentExpression.range
    );
    return null;
  }
  return {
    parent: isEvaluatedResourceId(evaluatedParent)
      ? parentValue
      : normalizeModelParent(parentValue, subtype, context.namespace),
    parentRange: parentExpression.range,
    parentOrigin: expressionEvaluationOrigin(parentExpression, context),
    implRange: expression.range,
    textures: modelImplTextures(call, subtype, context, onError)
  };
}

function modelImplTextures(
  call: CallExprNode | undefined,
  subtype: string,
  context: EvaluationContext,
  onError: ModelImplOptions["onError"]
): ModelImplData["textures"] {
  const textures: ModelImplData["textures"] = new Map();
  if (!call) {
    return textures;
  }
  const positional = call.args.filter(arg => !arg.name);
  if (positional.length > 1) {
    onError("rsgl.invalidModelImplArgument", "Model impl allows named texture arguments, or one positional texture argument.", call.range);
  }
  if (positional.length === 1) {
    const value = modelImplTextureValue(positional[0], subtype, context, onError);
    if (value) {
      textures.set(subtype === "item" ? "layer0" : "all", {
        value,
        range: positional[0].value.range,
        origin: expressionEvaluationOrigin(positional[0].value, context)
      });
    }
  }
  for (const arg of call.args.filter(arg => arg.name)) {
    const value = modelImplTextureValue(arg, subtype, context, onError);
    if (value && arg.name) {
      textures.set(arg.name.text, {
        value,
        range: arg.value.range,
        origin: expressionEvaluationOrigin(arg.value, context)
      });
    }
  }
  return textures;
}

function modelImplTextureValue(
  arg: ArgumentNode,
  subtype: string,
  context: EvaluationContext,
  onError: ModelImplOptions["onError"]
): string | null {
  const evaluatedValue = evaluateExpression(arg.value, context);
  if (isEvaluatedTextureVariable(evaluatedValue)) {
    return evaluatedValue.value;
  }
  if (isEvaluatedResourceId(evaluatedValue)) {
    if (evaluatedValue.resourceKind !== "texture") {
      context.onResourceValueFailure?.();
      onError(
        "rsgl.resourceIdKindMismatch",
        `${typeKindForResourceValueKind(evaluatedValue.resourceKind)} cannot be used where TextureId is required.`,
        arg.value.range
      );
      return null;
    }
    return evaluationScalarText(evaluatedValue);
  }
  const value = evaluationScalarText(evaluatedValue);
  if (!value) {
    onError("rsgl.invalidModelImplArgument", "Model impl texture argument must evaluate to a static texture id.", arg.value.range);
    return null;
  }
  if (value.startsWith("#")) {
    return value;
  }
  return normalizeResourceValue(value, context.namespace, subtype === "item" ? "item" : "block");
}

function normalizeModelParent(value: string, subtype: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  if (value.includes("/")) {
    return `${namespace}:${value}`;
  }
  return `minecraft:${subtype}/${value}`;
}
