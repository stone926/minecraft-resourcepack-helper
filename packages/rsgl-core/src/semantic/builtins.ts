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
    builtinFunction("seq", [{ name: "pattern", type: stringType, optional: false }], { kind: "List", elementType: stringType }),
    builtinFunction("pad", [
      { name: "value", type: numberType, optional: false },
      { name: "width", type: numberType, optional: false }
    ], stringType),
    builtinFunction("yaw", [{ name: "direction", type: stringType, optional: false }], numberType),
    builtinFunction("glob", [{ name: "pattern", type: stringType, optional: false }], { kind: "List", elementType: stringType }),
    builtinFunction("raw_json", [{ name: "path", type: stringType, optional: false }], jsonType),
    builtinFunction("raw_json_file", [{ name: "path", type: stringType, optional: false }], jsonType),
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
    builtinFunction("cubeAll", [
      { name: "id", type: resourceIdType, optional: false },
      { name: "texture", type: textureIdType, optional: true }
    ], jsonType),
    builtinFunction("itemGenerated", [
      { name: "id", type: resourceIdType, optional: false },
      { name: "texture", type: textureIdType, optional: true }
    ], jsonType),
    builtinFunction("blockFamily", [
      { name: "base", type: resourceIdType, optional: false },
      { name: "texture", type: textureIdType, optional: true },
      { name: "variants", type: { kind: "List", elementType: stringType }, optional: true },
      { name: "itemModels", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("stairs", [
      { name: "base", type: modelIdType, optional: false },
      { name: "inner", type: modelIdType, optional: false },
      { name: "outer", type: modelIdType, optional: false },
      { name: "uvlock", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("slab", [
      { name: "bottom", type: modelIdType, optional: false },
      { name: "top", type: modelIdType, optional: false },
      { name: "double", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("fence", [
      { name: "post", type: modelIdType, optional: false },
      { name: "side", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("fenceGate", [
      { name: "base", type: modelIdType, optional: false },
      { name: "open", type: modelIdType, optional: false },
      { name: "wall", type: modelIdType, optional: false },
      { name: "wallOpen", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("door", [
      { name: "bottomLeft", type: modelIdType, optional: false },
      { name: "bottomLeftOpen", type: modelIdType, optional: false },
      { name: "bottomRight", type: modelIdType, optional: false },
      { name: "bottomRightOpen", type: modelIdType, optional: false },
      { name: "topLeft", type: modelIdType, optional: false },
      { name: "topLeftOpen", type: modelIdType, optional: false },
      { name: "topRight", type: modelIdType, optional: false },
      { name: "topRightOpen", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("trapdoor", [
      { name: "bottom", type: modelIdType, optional: false },
      { name: "top", type: modelIdType, optional: false },
      { name: "open", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("wall", [
      { name: "post", type: modelIdType, optional: false },
      { name: "side", type: modelIdType, optional: false },
      { name: "sideTall", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("pane", [
      { name: "post", type: modelIdType, optional: false },
      { name: "side", type: modelIdType, optional: false },
      { name: "sideAlt", type: modelIdType, optional: false },
      { name: "noSide", type: modelIdType, optional: false },
      { name: "noSideAlt", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("horizontalFacing", [
      { name: "model", type: modelIdType, optional: false },
      { name: "state", type: jsonType, optional: true },
      { name: "uvlock", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("axisRotated", [
      { name: "vertical", type: modelIdType, optional: false },
      { name: "horizontal", type: modelIdType, optional: false },
      { name: "state", type: jsonType, optional: true },
      { name: "uvlock", type: booleanType, optional: true }
    ], jsonType),
    builtinFunction("randomVariants", [
      { name: "models", type: { kind: "List", elementType: jsonType }, optional: false },
      { name: "state", type: jsonType, optional: true }
    ], jsonType),
    builtinFunction("itemRangeFrames", [
      { name: "property", type: resourceIdType, optional: false },
      { name: "frames", type: jsonType, optional: false },
      { name: "model", type: resourceIdType, optional: false },
      { name: "threshold", type: jsonType, optional: true },
      { name: "fallback", type: resourceIdType, optional: true },
      { name: "component", type: resourceIdType, optional: true },
      { name: "source", type: stringType, optional: true },
      { name: "target", type: stringType, optional: true },
      { name: "wobble", type: booleanType, optional: true },
      { name: "scale", type: numberType, optional: true }
    ], jsonType),
    builtinFunction("itemSelectCases", [
      { name: "property", type: resourceIdType, optional: false },
      { name: "cases", type: jsonType, optional: false },
      { name: "fallback", type: resourceIdType, optional: true },
      { name: "component", type: resourceIdType, optional: true }
    ], jsonType),
    builtinFunction("atlasDirectory", [
      { name: "source", type: stringType, optional: false },
      { name: "prefix", type: stringType, optional: true }
    ], jsonType),
    builtinFunction("particlesSeq", [
      { name: "pattern", type: jsonType, optional: false }
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
