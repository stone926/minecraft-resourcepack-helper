import {
  anyType,
  booleanType,
  jsonType,
  modelIdType,
  numberType,
  resourceIdType,
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
    builtinValue("HORIZONTAL"),
    builtinValue("DIRECTIONS"),
    builtinValue("STAIR_SHAPES"),
    builtinValue("COLORS_16"),
    ...enumConstants.map(name => builtinValue(name, stringType)),
    builtinFunction("product", [{ name: "source", type: jsonType, optional: false }], { kind: "List", elementType: jsonType }),
    builtinFunction("seq", [
      { name: "pattern", type: { kind: "Union", options: [stringType, { kind: "Function" }] }, optional: false },
      { name: "pad", type: numberType, optional: true }
    ], { kind: "List", elementType: stringType }),
    builtinFunction("pad", [
      { name: "value", type: numberType, optional: false },
      { name: "width", type: numberType, optional: false }
    ], stringType),
    builtinFunction("yaw", [{ name: "direction", type: stringType, optional: false }], numberType),
    builtinFunction("glob", [{ name: "pattern", type: stringType, optional: false }], { kind: "List", elementType: stringType }),
    builtinFunction("startsWith", [
      { name: "str", type: stringType, optional: false },
      { name: "prefix", type: stringType, optional: false }
    ], booleanType),
    builtinFunction("endsWith", [
      { name: "str", type: stringType, optional: false },
      { name: "suffix", type: stringType, optional: false }
    ], booleanType),
    builtinFunction("replace", [
      { name: "str", type: stringType, optional: false },
      { name: "old", type: stringType, optional: false },
      { name: "new", type: stringType, optional: false }
    ], stringType),
    builtinFunction("padStart", [
      { name: "str", type: stringType, optional: false },
      { name: "len", type: numberType, optional: false },
      { name: "pad", type: stringType, optional: false }
    ], stringType),
    builtinFunction("padEnd", [
      { name: "str", type: stringType, optional: false },
      { name: "len", type: numberType, optional: false },
      { name: "pad", type: stringType, optional: false }
    ], stringType),
    builtinFunction("atlasDirectory", [
      { name: "source", type: stringType, optional: false },
      { name: "prefix", type: stringType, optional: true }
    ], jsonType),
    builtinFunction("particlesSeq", [
      { name: "pattern", type: jsonType, optional: false },
      { name: "pad", type: numberType, optional: true }
    ], jsonType),
    builtinFunction("mcmetaAnimation", [
      { name: "frametime", type: numberType, optional: true },
      { name: "interpolate", type: booleanType, optional: true },
      { name: "frames", type: jsonType, optional: true }
    ], jsonType),
    builtinFunction("nineSliceGui", [
      { name: "width", type: numberType, optional: false },
      { name: "height", type: numberType, optional: false },
      { name: "border", type: jsonType, optional: false },
      { name: "stretch_inner", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("equipmentLayers", [
      { name: "texture", type: textureIdType, optional: false },
      { name: "layers", type: jsonType, optional: false },
      { name: "dyeable", type: booleanType, optional: true },
      { name: "color", type: numberType, optional: true },
      { name: "use_player_texture", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("model_path", [{ name: "id", type: modelIdType, optional: false }], stringType),
    builtinFunction("texture_path", [{ name: "id", type: textureIdType, optional: false }], stringType),
    builtinFunction("resource_namespace", [{ name: "id", type: resourceIdType, optional: false }], stringType),
    builtinFunction("resource_path", [{ name: "id", type: resourceIdType, optional: false }], stringType),
    builtinValue("index", numberType)
  ];
}

function builtinValue(name: string, type = anyType): RsglSymbol {
  return { name, kind: "builtin", type };
}

function builtinFunction(name: string, parameters: RsglParameterSymbol[], returnType = anyType): RsglSymbol {
  return {
    name,
    kind: "builtin",
    type: { kind: "Function" },
    signature: { parameters, returnType }
  };
}
