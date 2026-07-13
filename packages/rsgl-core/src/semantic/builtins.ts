import {
  rsglResourceIdConstructors,
  typeKindForResourceValueKind
} from "../resourceIdSemantics";
import type { RsglResourceValueKind } from "../resourceIdSemantics";
import {
  anyType,
  booleanType,
  jsonType,
  modelIdType,
  numberType,
  resourceIdType,
  RsglBuiltinEffect,
  RsglParameterSymbol,
  RsglSymbol,
  stringType,
  textureIdType
} from "./types";

const enumConstants = [
  "north",
  "east",
  "south",
  "west",
  "up",
  "down",
  "x",
  "y",
  "z",
  "top",
  "bottom",
  "none",
  "low",
  "tall",
  "straight",
  "inner_left",
  "inner_right",
  "outer_left",
  "outer_right",
  "spawn",
  "day_time",
  "daytime",
  "moon_phase",
  "planks",
  "cube",
  "cube_all",
  "slab",
  "stairs",
  "fence",
  "fence_gate",
  "door",
  "trapdoor",
  "button",
  "pressure_plate",
  "sign",
  "hanging_sign",
  "boat",
  "chest_boat",
  "model",
  "blockstate",
  "item",
  "bitmap",
  "space",
  "ttf",
  "unihex",
  "reference",
  "legacy_unicode"
];

export function createBuiltinSymbols(): RsglSymbol[] {
  return [
    builtinValue("HORIZONTAL", listOf(stringType)),
    builtinValue("DIRECTIONS", listOf(stringType)),
    builtinValue("STAIR_SHAPES", listOf(stringType)),
    builtinValue("COLORS_16", listOf(stringType)),
    ...enumConstants.map(name => builtinValue(name, stringType)),
    ...Object.entries(rsglResourceIdConstructors).map(([name, kind]) =>
      resourceIdConstructor(name, kind)
    ),
    builtinFunction("product", "pure", [{ name: "source", type: jsonType, optional: false }], { kind: "List", elementType: jsonType }),
    builtinFunction("seq", "pure", [
      { name: "pattern", type: { kind: "Union", options: [stringType, { kind: "Function" }] }, optional: false },
      { name: "pad", type: numberType, optional: true }
    ], { kind: "List", elementType: stringType }),
    builtinFunction("pad", "pure", [
      { name: "value", type: numberType, optional: false },
      { name: "width", type: numberType, optional: false }
    ], stringType),
    builtinFunction("yaw", "pure", [{ name: "direction", type: stringType, optional: false }], numberType),
    builtinFunction("glob", "io", [{ name: "pattern", type: stringType, optional: false }], { kind: "List", elementType: stringType }),
    builtinFunction("startsWith", "pure", [
      { name: "str", type: stringType, optional: false },
      { name: "prefix", type: stringType, optional: false }
    ], booleanType),
    builtinFunction("endsWith", "pure", [
      { name: "str", type: stringType, optional: false },
      { name: "suffix", type: stringType, optional: false }
    ], booleanType),
    builtinFunction("has", "pure", [
      { name: "object", type: anyType, optional: false },
      { name: "key", type: stringType, optional: false }
    ], booleanType),
    builtinFunction("replace", "pure", [
      { name: "str", type: stringType, optional: false },
      { name: "old", type: stringType, optional: false },
      { name: "new", type: stringType, optional: false }
    ], stringType),
    builtinFunction("padStart", "pure", [
      { name: "str", type: stringType, optional: false },
      { name: "len", type: numberType, optional: false },
      { name: "pad", type: stringType, optional: false }
    ], stringType),
    builtinFunction("padEnd", "pure", [
      { name: "str", type: stringType, optional: false },
      { name: "len", type: numberType, optional: false },
      { name: "pad", type: stringType, optional: false }
    ], stringType),
    builtinFunction("atlasDirectory", "pure", [
      { name: "source", type: stringType, optional: false },
      { name: "prefix", type: stringType, optional: true }
    ], jsonType),
    builtinFunction("particlesSeq", "pure", [
      { name: "pattern", type: jsonType, optional: false },
      { name: "pad", type: numberType, optional: true }
    ], jsonType),
    builtinFunction("mcmetaAnimation", "pure", [
      { name: "frametime", type: numberType, optional: true },
      { name: "interpolate", type: booleanType, optional: true },
      { name: "frames", type: jsonType, optional: true }
    ], jsonType),
    builtinFunction("nineSliceGui", "pure", [
      { name: "width", type: numberType, optional: false },
      { name: "height", type: numberType, optional: false },
      { name: "border", type: jsonType, optional: false },
      { name: "stretch_inner", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("equipmentLayers", "pure", [
      { name: "texture", type: textureIdType, optional: false },
      { name: "layers", type: jsonType, optional: false },
      { name: "dyeable", type: booleanType, optional: true },
      { name: "color", type: numberType, optional: true },
      { name: "use_player_texture", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("model_path", "pure", [{ name: "id", type: modelIdType, optional: false }], stringType),
    builtinFunction("texture_path", "pure", [{ name: "id", type: textureIdType, optional: false }], stringType),
    builtinFunction("resource_namespace", "pure", [{ name: "id", type: resourceIdType, optional: false }], stringType),
    builtinFunction("resource_path", "pure", [{ name: "id", type: resourceIdType, optional: false }], stringType),
    builtinValue("index", numberType)
  ];
}

/**
 * Effect lookup derived from the same builtin declarations installed in every
 * semantic scope. Compiler-only consumers use this instead of maintaining a
 * second list of IO builtin names.
 */
export const builtinEffects: ReadonlyMap<string, RsglBuiltinEffect> = new Map(
  createBuiltinSymbols()
    .filter(symbol => symbol.kind === "builtin" && symbol.signature)
    .map(symbol => [symbol.name, symbol.effect!] as const)
);

export function builtinEffect(name: string): RsglBuiltinEffect | undefined {
  return builtinEffects.get(name);
}

function listOf(elementType: RsglSymbol["type"]): RsglSymbol["type"] {
  return { kind: "List", elementType };
}

function builtinValue(name: string, type = anyType): RsglSymbol {
  return { name, kind: "builtin", type };
}

function resourceIdConstructor(name: string, kind: RsglResourceValueKind): RsglSymbol {
  const typeKind = typeKindForResourceValueKind(kind);
  const returnType = typeKind === "ModelId"
    ? modelIdType
    : typeKind === "TextureId"
      ? textureIdType
      : resourceIdType;
  return builtinFunction(name, "pure", [{
    name: "value",
    type: { kind: "Union", options: [stringType, returnType] },
    optional: false
  }], returnType);
}

function builtinFunction(
  name: string,
  effect: RsglBuiltinEffect,
  parameters: RsglParameterSymbol[],
  returnType = anyType
): RsglSymbol {
  return {
    name,
    kind: "builtin",
    type: { kind: "Function" },
    effect,
    signature: { parameters, returnType }
  };
}
