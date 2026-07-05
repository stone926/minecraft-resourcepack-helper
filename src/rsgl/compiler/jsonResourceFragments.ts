import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  IdentifierExprNode,
  TextRange,
  UseDeclNode
} from "../parser";
import type { RsglGenericJsonResourceKind } from "../resourceKinds";
import { EvaluationContext, EvaluationValue, evaluateExpression } from "./evaluate";
import { JsonValue } from "./ir";
import { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";
import { expandSequencePattern } from "./sequences";
import { appendGeneratedPath } from "./sourcePaths";

export type JsonResourceFragmentKind = RsglGenericJsonResourceKind | "mcmeta";

export interface RsglJsonResourceFragmentOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

export function compileJsonResourceUseFragment(
  kind: JsonResourceFragmentKind,
  statement: UseDeclNode,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions = {}
): ResourceBodyFragment | undefined {
  const call = jsonResourceFragmentCall(statement.expression);
  if (!call) {
    return undefined;
  }

  if (kind === "atlas" && call.callee.name.text === "atlasDirectory") {
    return compileAtlasDirectory(call, context, options);
  }
  if (kind === "particles" && call.callee.name.text === "particlesSeq") {
    return compileParticlesSeq(call, context, options);
  }
  if (kind === "mcmeta" && call.callee.name.text === "mcmetaAnimation") {
    return compileMcmetaAnimation(call, context);
  }
  if (kind === "mcmeta" && call.callee.name.text === "nineSliceGui") {
    return compileNineSliceGui(call, context, options);
  }
  if (kind === "equipment" && call.callee.name.text === "equipmentLayers") {
    return compileEquipmentLayers(call, context, options);
  }

  return undefined;
}

function compileAtlasDirectory(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): ResourceBodyFragment | undefined {
  const source = stringArg(call, "source", 0, context, options);
  if (!source) {
    return undefined;
  }

  const entry: Record<string, JsonValue> = {
    type: "minecraft:directory",
    source
  };
  const prefix = optionalStringArg(call, "prefix", 1, context, options);
  if (prefix !== null) {
    entry.prefix = prefix;
  }
  return jsonFragment({ sources: [entry] });
}

function compileParticlesSeq(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): ResourceBodyFragment | undefined {
  const arg = requiredArg(call, "pattern", 0, options);
  if (!arg) {
    return undefined;
  }

  const value = normalizeJsonValue(evaluateExpression(arg.value, context));
  const textures = textureSequence(value, context.namespace);
  if (!textures) {
    options.onError?.("rsgl.invalidParticlesSeqArgument", "particlesSeq pattern must evaluate to a texture id string or list of texture id strings.", arg.value.range);
    return undefined;
  }
  const texturesPath = "/textures";
  const mappings: ResourceBodyMapping[] = [
    {
      generatedPath: texturesPath,
      sourceRange: arg.value.range,
      context
    },
    ...textures.map((_, index) => ({
      generatedPath: appendGeneratedPath(texturesPath, String(index)),
      sourceRange: arg.value.range,
      context
    }))
  ];
  return jsonFragment({ textures }, mappings);
}

function compileMcmetaAnimation(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext
): ResourceBodyFragment {
  const animation: Record<string, JsonValue> = {};
  copyOptionalArg(animation, "frametime", call, context, 0);
  copyOptionalArg(animation, "interpolate", call, context, 1);
  copyOptionalArg(animation, "frames", call, context, 2);
  return jsonFragment({ animation });
}

function compileNineSliceGui(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): ResourceBodyFragment | undefined {
  const width = numberArg(call, "width", 0, context, options);
  const height = numberArg(call, "height", 1, context, options);
  const borderArg = requiredArg(call, "border", 2, options);
  if (width === null || height === null || !borderArg) {
    return undefined;
  }

  const scaling: Record<string, JsonValue> = {
    type: "nine_slice",
    width,
    height,
    border: normalizeJsonValue(evaluateExpression(borderArg.value, context))
  };
  copyOptionalArg(scaling, "stretch_inner", call, context, 3);
  return jsonFragment({
    gui: {
      scaling
    }
  });
}

function compileEquipmentLayers(
  call: CallExprNode & { callee: IdentifierExprNode },
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): ResourceBodyFragment | undefined {
  const texture = stringArg(call, "texture", 0, context, options);
  const layersArg = requiredArg(call, "layers", 1, options);
  if (!texture || !layersArg) {
    return undefined;
  }

  const layers = stringList(evaluateExpression(layersArg.value, context));
  if (!layers) {
    options.onError?.("rsgl.invalidEquipmentLayersArgument", "equipmentLayers layers must evaluate to a layer name string or list of layer name strings.", layersArg.value.range);
    return undefined;
  }

  const layerEntry: Record<string, JsonValue> = {
    texture: normalizeResourceId(texture, context.namespace)
  };
  const colorArg = findArg(call, "color");
  const dyeableArg = findArg(call, "dyeable");
  const usePlayerTextureArg = findArg(call, "use_player_texture") ?? findArg(call, "usePlayerTexture");
  const color = colorArg ? evaluateExpression(colorArg.value, context) : undefined;
  const dyeable = dyeableArg ? Boolean(evaluateExpression(dyeableArg.value, context)) : color !== undefined;
  if (dyeable) {
    const undyedColorKey = "color_when_undyed";
    layerEntry.dyeable = typeof color === "number" && Number.isFinite(color)
      ? { [undyedColorKey]: color }
      : {};
  }
  if (usePlayerTextureArg) {
    const usePlayerTextureKey = "use_player_texture";
    layerEntry[usePlayerTextureKey] = Boolean(evaluateExpression(usePlayerTextureArg.value, context));
  }

  const layerMap: Record<string, JsonValue> = {};
  for (const layer of layers) {
    layerMap[layer] = [{ ...layerEntry }];
  }
  return jsonFragment({ layers: layerMap });
}

function jsonFragment(
  content: Record<string, JsonValue>,
  mappings?: ResourceBodyMapping[]
): ResourceBodyFragment {
  return { content, mappings };
}

function jsonResourceFragmentCall(expression: ExprNode): (CallExprNode & { callee: IdentifierExprNode }) | null {
  return expression.kind === "CallExpr" && expression.callee.kind === "IdentifierExpr"
    ? expression as CallExprNode & { callee: IdentifierExprNode }
    : null;
}

function textureSequence(value: JsonValue, namespace: string): string[] | null {
  if (typeof value === "string") {
    return expandSequencePattern(value).map(item => normalizeResourceId(item, namespace));
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    return null;
  }
  return value.map(item => normalizeResourceId(item, namespace));
}

function stringList(value: EvaluationValue): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    return null;
  }
  return value;
}

function stringArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): string | null {
  const arg = requiredArg(call, name, positionalIndex, options);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a string.`, arg.value.range);
    return null;
  }
  return value;
}

function optionalStringArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): string | null {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a string.`, arg.value.range);
    return null;
  }
  return value;
}

function numberArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): number | null {
  const arg = requiredArg(call, name, positionalIndex, options);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a finite number.`, arg.value.range);
    return null;
  }
  return value;
}

function requiredArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  options: RsglJsonResourceFragmentOptions
): ArgumentNode | null {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    options.onError?.("rsgl.compileMissingArgument", `Missing fragment argument '${name}'.`, call.range);
  }
  return arg ?? null;
}

function findArg(call: CallExprNode, name: string, positionalIndex?: number): ArgumentNode | undefined {
  return call.args.find(arg => arg.name?.text === name)
    ?? (positionalIndex === undefined ? undefined : call.args.filter(arg => !arg.name)[positionalIndex]);
}

function copyOptionalArg(
  target: Record<string, JsonValue>,
  name: string,
  call: CallExprNode,
  context: EvaluationContext,
  positionalIndex: number
): void {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    return;
  }
  const value = evaluateExpression(arg.value, context);
  if (value !== undefined) {
    target[name] = normalizeJsonValue(value);
  }
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  return value === undefined ? null : value;
}

function normalizeResourceId(value: string, namespace: string): string {
  return value.includes(":") ? value : `${namespace}:${value}`;
}
