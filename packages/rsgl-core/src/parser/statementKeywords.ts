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
export {
  modelElementBodyClauseKeywords,
  modelElementHeaderClauseKeywords,
  modelFaceIntroducerKeywords,
  modelFaceTargets,
  modelGeometryStatementKeywords
} from "../modelGeometrySyntax";

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
