import { rsglExternResourceKinds, rsglResourceKinds } from "../resourceKinds";
import { rsglItemModelLexicalKeywords } from "../itemModelSyntax";
import { rsglModelGeometryKeywords } from "../modelGeometrySyntax";

const declarationKeywords = [
  "target",
  "namespace",
  "import",
  "export",
  "extern",
  "overlay",
  "type",
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
  ...rsglExternResourceKinds,
  "local",
  "custom",
  "vanilla",
  "var",
  "from",
  "as",
  "impl",
  "format",
  "mc",
  "java",
  "variants",
  "multipart",
  "part",
  "always",
  "when",
  "random",
  "option",
  "weight",
  "with",
  "choice",
  "raw",
  "merge",
  "deep",
  "strict",
  "upsert",
  "append",
  ...rsglItemModelLexicalKeywords,
  "base",
  "else",
  "in",
  "not",
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
  ...rsglModelGeometryKeywords
]);

export function isTopLevelKeyword(text: string): boolean {
  return (topLevelKeywords as readonly string[]).includes(text);
}

export function isResourceKeyword(text: string): boolean {
  return (resourceKeywords as readonly string[]).includes(text);
}
