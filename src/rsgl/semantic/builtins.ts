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
  "planks",
  "slab",
  "stairs",
  "fence",
  "fence_gate",
  "door",
  "trapdoor"
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
    builtinFunction("cubeAll", [
      { name: "id", type: resourceIdType, optional: false },
      { name: "texture", type: textureIdType, optional: true }
    ], jsonType),
    builtinFunction("itemGenerated", [
      { name: "id", type: resourceIdType, optional: false },
      { name: "texture", type: textureIdType, optional: true }
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
    builtinFunction("wall", [
      { name: "post", type: modelIdType, optional: false },
      { name: "side", type: modelIdType, optional: false },
      { name: "sideTall", type: modelIdType, optional: false }
    ], jsonType),
    builtinFunction("randomVariants", [{ name: "models", type: { kind: "List", elementType: jsonType }, optional: false }], jsonType),
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
