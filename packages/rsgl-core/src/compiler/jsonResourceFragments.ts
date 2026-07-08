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
import { expandSequencePattern, sequencePadWidth } from "./sequences";
import { appendGeneratedPath } from "./sourcePaths";

export type JsonResourceFragmentKind = RsglGenericJsonResourceKind | "mcmeta";

export interface RsglJsonResourceFragmentOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

interface EvaluatedFragmentArg<T> {
  arg: ArgumentNode;
  value: T;
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
    source: source.value
  };
  const prefix = optionalStringArg(call, "prefix", 1, context, options);
  if (prefix) {
    entry.prefix = prefix.value;
  }
  const sourcePath = "/sources/0";
  const mappings: ResourceBodyMapping[] = [
    mapping("/sources", call.range, context),
    mapping(sourcePath, call.range, context),
    mapping(appendGeneratedPath(sourcePath, "type"), call.callee.name.range, context),
    mapping(appendGeneratedPath(sourcePath, "source"), source.arg.value.range, context)
  ];
  if (prefix) {
    mappings.push(mapping(appendGeneratedPath(sourcePath, "prefix"), prefix.arg.value.range, context));
  }
  return jsonFragment({ sources: [entry] }, mappings);
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
  const padArg = findArg(call, "pad");
  const padWidth = padArg ? sequencePadWidth(evaluateExpression(padArg.value, context)) : null;
  if (padArg && padWidth === null) {
    options.onError?.("rsgl.invalidParticlesSeqPadding", "particlesSeq pad must evaluate to a non-negative integer.", padArg.value.range);
    return undefined;
  }

  const textures = textureSequence(value, context.namespace, padWidth);
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
  const mappings: ResourceBodyMapping[] = [
    mapping("/animation", call.range, context)
  ];
  const frametime = copyOptionalArg(animation, "frametime", call, context, 0);
  const interpolate = copyOptionalArg(animation, "interpolate", call, context, 1);
  const frames = copyOptionalArg(animation, "frames", call, context, 2);
  addOptionalArgMapping(mappings, "/animation/frametime", frametime, context);
  addOptionalArgMapping(mappings, "/animation/interpolate", interpolate, context);
  addOptionalArgMapping(mappings, "/animation/frames", frames, context);
  return jsonFragment({ animation }, mappings);
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
    width: width.value,
    height: height.value,
    border: normalizeJsonValue(evaluateExpression(borderArg.value, context))
  };
  const stretchInner = copyOptionalArg(scaling, "stretch_inner", call, context, 3);
  const scalingPath = "/gui/scaling";
  const mappings: ResourceBodyMapping[] = [
    mapping("/gui", call.range, context),
    mapping(scalingPath, call.range, context),
    mapping(appendGeneratedPath(scalingPath, "type"), call.callee.name.range, context),
    mapping(appendGeneratedPath(scalingPath, "width"), width.arg.value.range, context),
    mapping(appendGeneratedPath(scalingPath, "height"), height.arg.value.range, context),
    mapping(appendGeneratedPath(scalingPath, "border"), borderArg.value.range, context)
  ];
  addOptionalArgMapping(mappings, appendGeneratedPath(scalingPath, "stretch_inner"), stretchInner, context);
  return jsonFragment({
    gui: {
      scaling
    }
  }, mappings);
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
    texture: normalizeResourceId(texture.value, context.namespace)
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
  const mappings = equipmentLayersMappings(layers, {
    texture: texture.arg,
    layers: layersArg,
    dyeable: dyeableArg,
    color: colorArg,
    usePlayerTexture: usePlayerTextureArg
  }, layerEntry, context);
  return jsonFragment({ layers: layerMap }, mappings);
}

function jsonFragment(
  content: Record<string, JsonValue>,
  mappings?: ResourceBodyMapping[]
): ResourceBodyFragment {
  return { content, mappings };
}

function mapping(generatedPath: string, sourceRange: TextRange, context: EvaluationContext): ResourceBodyMapping {
  return { generatedPath, sourceRange, context };
}

function addOptionalArgMapping(
  mappings: ResourceBodyMapping[],
  generatedPath: string,
  arg: ArgumentNode | undefined,
  context: EvaluationContext
): void {
  if (arg) {
    mappings.push(mapping(generatedPath, arg.value.range, context));
  }
}

function equipmentLayersMappings(
  layers: string[],
  args: {
    texture: ArgumentNode;
    layers: ArgumentNode;
    dyeable?: ArgumentNode;
    color?: ArgumentNode;
    usePlayerTexture?: ArgumentNode;
  },
  layerEntry: Record<string, JsonValue>,
  context: EvaluationContext
): ResourceBodyMapping[] {
  const mappings: ResourceBodyMapping[] = [
    mapping("/layers", args.layers.value.range, context)
  ];
  for (const layer of layers) {
    const layerPath = appendGeneratedPath("/layers", layer);
    const entryPath = appendGeneratedPath(layerPath, "0");
    mappings.push(
      mapping(layerPath, args.layers.value.range, context),
      mapping(entryPath, args.texture.value.range, context),
      mapping(appendGeneratedPath(entryPath, "texture"), args.texture.value.range, context)
    );
    if (isJsonObjectValue(layerEntry.dyeable)) {
      const dyeableRange = args.dyeable?.value.range ?? args.color?.value.range ?? args.texture.value.range;
      mappings.push(mapping(appendGeneratedPath(entryPath, "dyeable"), dyeableRange, context));
      if (Object.hasOwn(layerEntry.dyeable, "color_when_undyed") && args.color) {
        mappings.push(mapping(
          appendGeneratedPath(appendGeneratedPath(entryPath, "dyeable"), "color_when_undyed"),
          args.color.value.range,
          context
        ));
      }
    }
    if (Object.hasOwn(layerEntry, "use_player_texture") && args.usePlayerTexture) {
      mappings.push(mapping(appendGeneratedPath(entryPath, "use_player_texture"), args.usePlayerTexture.value.range, context));
    }
  }
  return mappings;
}

function isJsonObjectValue(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResourceFragmentCall(expression: ExprNode): (CallExprNode & { callee: IdentifierExprNode }) | null {
  return expression.kind === "CallExpr" && expression.callee.kind === "IdentifierExpr"
    ? expression as CallExprNode & { callee: IdentifierExprNode }
    : null;
}

function textureSequence(value: JsonValue, namespace: string, padWidth: number | null): string[] | null {
  if (typeof value === "string") {
    return expandSequencePattern(value, { pad: padWidth }).map(item => normalizeResourceId(item, namespace));
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    return null;
  }
  return value.flatMap(item => expandSequencePattern(item, { pad: padWidth }).map(entry => normalizeResourceId(entry, namespace)));
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
): EvaluatedFragmentArg<string> | null {
  const arg = requiredArg(call, name, positionalIndex, options);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a string.`, arg.value.range);
    return null;
  }
  return { arg, value };
}

function optionalStringArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): EvaluatedFragmentArg<string> | null {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "string") {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a string.`, arg.value.range);
    return null;
  }
  return { arg, value };
}

function numberArg(
  call: CallExprNode,
  name: string,
  positionalIndex: number,
  context: EvaluationContext,
  options: RsglJsonResourceFragmentOptions
): EvaluatedFragmentArg<number> | null {
  const arg = requiredArg(call, name, positionalIndex, options);
  if (!arg) {
    return null;
  }
  const value = evaluateExpression(arg.value, context);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    options.onError?.("rsgl.invalidJsonResourceFragmentArgument", `Fragment argument '${name}' must evaluate to a finite number.`, arg.value.range);
    return null;
  }
  return { arg, value };
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
): ArgumentNode | undefined {
  const arg = findArg(call, name, positionalIndex);
  if (!arg) {
    return undefined;
  }
  const value = evaluateExpression(arg.value, context);
  if (value !== undefined) {
    target[name] = normalizeJsonValue(value);
  }
  return arg;
}

function normalizeJsonValue(value: EvaluationValue): JsonValue {
  if (value === undefined || (value && typeof value === "object" && !Array.isArray(value) && value.kind === "lambda")) {
    return null;
  }
  return value as JsonValue;
}

function normalizeResourceId(value: string, namespace: string): string {
  return value.includes(":") ? value : `${namespace}:${value}`;
}
