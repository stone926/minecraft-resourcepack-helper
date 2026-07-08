import { rsglResourceKinds } from "../resourceKinds";

const declarationKeywords = [
  "target",
  "namespace",
  "import",
  "export",
  "extern",
  "overlay",
  "let",
  "table",
  "template"
] as const;

export const topLevelKeywords = [
  ...declarationKeywords,
  ...rsglResourceKinds,
  "use",
  "for",
  "if"
] as const;

export const resourceKeywords = rsglResourceKinds;

export const rsglKeywords = new Set<string>([
  ...topLevelKeywords,
  "from",
  "as",
  "impl",
  "format",
  "mc",
  "java",
  "variants",
  "multipart",
  "when",
  "apply",
  "random",
  "raw",
  "raw_json",
  "raw_json_file",
  "override",
  "append",
  "range",
  "select",
  "condition",
  "composite",
  "empty",
  "selected_item",
  "special",
  "base",
  "on_true",
  "on_false",
  "else",
  "in",
  "true",
  "false",
  "null",
  "and",
  "or",
  "match",
  "case",
  "fallback",
  "double",
  "models",
  "texture",
  "textures",
  "paletted_permutations",
  "palette_key",
  "parent",
  "generate",
  "box",
  "element",
  "from",
  "to",
  "face",
  "all",
  "down",
  "up",
  "north",
  "south",
  "west",
  "east",
  "uv",
  "rotation",
  "origin",
  "axis",
  "angle",
  "rescale",
  "cullface",
  "shade",
  "tintindex",
  "light_emission",
  "mirror",
  "translate"
]);

export function isTopLevelKeyword(text: string): boolean {
  return (topLevelKeywords as readonly string[]).includes(text);
}

export function isResourceKeyword(text: string): boolean {
  return (resourceKeywords as readonly string[]).includes(text);
}
