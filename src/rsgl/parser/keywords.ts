import { rsglResourceKinds } from "../resourceKinds";

const declarationKeywords = [
  "target",
  "namespace",
  "import",
  "export",
  "overlay",
  "let",
  "table",
  "template",
  "fragment"
] as const;

export const sugarKeywords = [
  "stairs",
  "slab",
  "fence",
  "wall",
  "pane",
  "cube_all",
  "item_generated",
  "items",
  "wood_family",
  "block_family"
] as const;

export const topLevelKeywords = [
  ...declarationKeywords,
  ...rsglResourceKinds,
  ...sugarKeywords,
  "use",
  "for",
  "if"
] as const;

export const resourceKeywords = rsglResourceKinds;

export const rsglKeywords = new Set<string>([
  ...topLevelKeywords,
  "from",
  "as",
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
  "parent",
  "generate"
]);

export function isTopLevelKeyword(text: string): boolean {
  return (topLevelKeywords as readonly string[]).includes(text);
}

export function isResourceKeyword(text: string): boolean {
  return (resourceKeywords as readonly string[]).includes(text);
}

export function isSugarKeyword(text: string): boolean {
  return (sugarKeywords as readonly string[]).includes(text);
}
