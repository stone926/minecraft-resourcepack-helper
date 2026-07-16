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

export const equipmentLayerClauseKeywords = ["texture", "dyeable", "color", "use_player_texture"];

export const binaryPrecedence = new Map<string, number>([
  ["||", 2],
  ["&&", 3],
  ["==", 4],
  ["!=", 4],
  ["<", 4],
  ["<=", 4],
  [">", 4],
  [">=", 4],
  ["in", 4],
  ["not in", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
  ["..", 7]
]);
