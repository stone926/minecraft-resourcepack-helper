export const resourceBodySectionKeywords = new Set([
  "textures",
  "animation",
  "sources",
  "filter",
  "gui",
  "scaling",
  "layers",
  "raw"
]);

export const itemRangeOptionKeywords = ["component", "source", "target", "wobble", "scale"];
export const itemSelectOptionKeywords = ["component"];
export const itemConditionOptionKeywords = ["component", "ignore_default", "index", "keybind", "predicate", "value"];
export const equipmentLayerClauseKeywords = ["texture", "dyeable", "color", "use_player_texture", "usePlayerTexture"];
export const modelElementHeaderClauseKeywords = ["from", "to", "rotation", "shade", "light_emission", "mirror", "translate", "texture", "uv", "cullface", "tintindex"];
export const modelElementBodyClauseKeywords = ["rotation", "shade", "light_emission", "mirror", "translate", "texture", "uv", "cullface", "tintindex"];
const modelFaceDirections = new Set(["down", "up", "north", "south", "west", "east"]);
export const modelFaceTargets = new Set([...modelFaceDirections, "all"]);
export const modelGeometryStatementKeywords = new Set(["box", "element"]);

export const binaryPrecedence = new Map<string, number>([
  ["||", 2],
  ["&&", 3],
  ["==", 4],
  ["!=", 4],
  ["<", 4],
  ["<=", 4],
  [">", 4],
  [">=", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
  ["..", 7]
]);

export type BodyMode = "topLevel" | "resource" | "variants" | "multipart";
