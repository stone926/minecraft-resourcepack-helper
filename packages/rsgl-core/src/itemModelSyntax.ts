/**
 * Target-independent syntax metadata for the RSGL item-model DSL.
 *
 * Minecraft field availability belongs in itemModelSchema.ts.  Keeping this
 * descriptor frontend-only lets the parser, formatter, grammar tests and LSP
 * agree on contextual keywords without making the AST depend on a target.
 */

export type RsglItemModelConstructor =
  | "range"
  | "select"
  | "condition"
  | "composite"
  | "special"
  | "first_match"
  | "empty"
  | "selected_item";

export type RsglItemModelBodyOwner =
  | "select"
  | "range"
  | "composite"
  | "first_match"
  | "itemModelTemplate";

export type RsglItemModelExpectedSlot =
  | "producer"
  | "clause"
  | "itemModel"
  | "optionKey";

export interface RsglItemModelConstructorDescriptor {
  readonly keyword: RsglItemModelConstructor;
  /** Token which must follow the constructor before it claims an expression. */
  readonly lookahead?: "property" | "base" | "{";
  readonly supportsTransformation: boolean;
  readonly supportsTints: boolean;
  readonly canonicalSnippet: string;
  readonly detail: string;
  readonly semanticTokenRole: "keyword";
}

export interface RsglItemModelBodyDescriptor {
  readonly owner: RsglItemModelBodyOwner;
  readonly leafClauses: readonly string[];
  readonly controlClauses: readonly ("let" | "for" | "if")[];
}

export const rsglItemModelConstructorDescriptors = Object.freeze([
  descriptor(
    "range",
    "property",
    true,
    false,
    "range property ${1:minecraft:damage} ${2:scale 1} {\n  entry ${3:0} => ${4:minecraft:item/model}\n  fallback ${5:minecraft:item/model}\n}",
    "Recursive range_dispatch item model"
  ),
  descriptor(
    "select",
    "property",
    true,
    false,
    "select property ${1:minecraft:display_context} {\n  case ${2:\"gui\"} => ${3:minecraft:item/model}\n  fallback ${4:minecraft:item/model}\n}",
    "Recursive select item model"
  ),
  descriptor(
    "condition",
    "property",
    true,
    false,
    "condition property ${1:minecraft:using_item} {\n  on_true ${2:minecraft:item/active}\n  on_false ${3:minecraft:item/idle}\n}",
    "Recursive condition item model"
  ),
  descriptor(
    "composite",
    "{",
    true,
    false,
    "composite {\n  model ${1:minecraft:item/base}\n  model ${2:minecraft:item/overlay}\n}",
    "Recursive composite item model"
  ),
  descriptor(
    "special",
    "base",
    true,
    false,
    "special base ${1:minecraft:item/shield} model { type: ${2:minecraft:shield} }",
    "Special renderer item model"
  ),
  descriptor(
    "first_match",
    "{",
    true,
    false,
    "first_match {\n  when property ${1:minecraft:using_item} => ${2:minecraft:item/active}\n  fallback ${3:minecraft:item/idle}\n}",
    "Ordered compile-time condition chain"
  ),
  descriptor("empty", "{", false, false, "empty {}", "Empty item model"),
  descriptor(
    "selected_item",
    "{",
    false,
    false,
    "selected_item {}",
    "Bundle selected-item model"
  )
] satisfies readonly RsglItemModelConstructorDescriptor[]);

export const rsglItemModelBodyDescriptors = Object.freeze([
  bodyDescriptor("select", ["case", "fallback"]),
  bodyDescriptor("range", ["entry", "frames", "fallback"]),
  bodyDescriptor("composite", ["model"]),
  bodyDescriptor("first_match", ["when", "fallback"]),
  {
    owner: "itemModelTemplate",
    leafClauses: [
      "model",
      "range",
      "select",
      "condition",
      "composite",
      "special",
      "first_match",
      "empty",
      "selected_item",
      "use"
    ],
    controlClauses: ["let", "for", "if"]
  }
] satisfies readonly RsglItemModelBodyDescriptor[]);

const constructorByKeyword = new Map(
  rsglItemModelConstructorDescriptors.map(item => [item.keyword, item] as const)
);

const bodyByOwner = new Map(
  rsglItemModelBodyDescriptors.map(item => [item.owner, item] as const)
);

export const rsglItemModelLexicalKeywords = Object.freeze(new Set([
  ...rsglItemModelConstructorDescriptors.map(item => item.keyword),
  ...rsglItemModelBodyDescriptors.flatMap(item => [
    ...item.leafClauses,
    ...item.controlClauses
  ]),
  "property",
  "on_true",
  "on_false",
  "with",
  "item_model"
]));

export function getRsglItemModelConstructorDescriptor(
  keyword: string
): RsglItemModelConstructorDescriptor | undefined {
  return constructorByKeyword.get(keyword as RsglItemModelConstructor);
}

export function getRsglItemModelBodyDescriptor(
  owner: RsglItemModelBodyOwner
): RsglItemModelBodyDescriptor {
  return bodyByOwner.get(owner)!;
}

/** Contextual lookahead used before a constructor is allowed to claim a value. */
export function isRsglItemModelConstructorStart(
  keyword: string,
  nextTokenText: string
): keyword is RsglItemModelConstructor {
  const item = getRsglItemModelConstructorDescriptor(keyword);
  if (!item) {
    return false;
  }
  return item.lookahead === undefined || item.lookahead === nextTokenText;
}

function descriptor(
  keyword: RsglItemModelConstructor,
  lookahead: RsglItemModelConstructorDescriptor["lookahead"],
  supportsTransformation: boolean,
  supportsTints: boolean,
  canonicalSnippet: string,
  detail: string
): RsglItemModelConstructorDescriptor {
  return {
    keyword,
    lookahead,
    supportsTransformation,
    supportsTints,
    canonicalSnippet,
    detail,
    semanticTokenRole: "keyword"
  };
}

function bodyDescriptor(
  owner: Exclude<RsglItemModelBodyOwner, "itemModelTemplate">,
  leafClauses: readonly string[]
): RsglItemModelBodyDescriptor {
  return {
    owner,
    leafClauses,
    controlClauses: ["let", "for", "if"]
  };
}
