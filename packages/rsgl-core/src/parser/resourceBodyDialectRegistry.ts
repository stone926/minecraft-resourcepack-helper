import { modelGeometryStatementKeywords } from "../modelGeometrySyntax";
import {
  isRsglResourceKind,
  type RsglResourceBodyDialect
} from "../resourceKinds";
import type { ResourceStatementNode, RsglToken } from "./types";

export type LegacyTemplateBodyParsePlan =
  | { kind: "block" }
  | {
      kind: "resourceBody";
      dialect: RsglResourceBodyDialect;
      detectedDialects: readonly RsglResourceBodyDialect[];
    };

export interface LegacyResourceBodyDialectDescriptor {
  dialect: RsglResourceBodyDialect;
  statementKeywords: readonly string[];
  statementKinds: readonly ResourceStatementNode["kind"][];
}

/** Shared parser/semantic registry for definition-local legacy body evidence. */
export const legacyResourceBodyDialectDescriptors = [
  {
    dialect: "model",
    statementKeywords: ["texture", ...modelGeometryStatementKeywords],
    statementKinds: ["ExternVarStmt", "ModelTextureStmt", "ModelElementStmt", "ModelTransformStmt"]
  },
  {
    dialect: "blockstate",
    statementKeywords: ["variants", "multipart"],
    statementKinds: ["VariantsSection", "MultipartSection", "VariantEntry", "MultipartEntry"]
  },
  {
    dialect: "item",
    statementKeywords: ["range", "select", "condition", "composite", "empty", "selected_item", "special"],
    statementKinds: [
      "ItemRangeStmt",
      "ItemSelectStmt",
      "ItemConditionStmt",
      "ItemCompositeStmt",
      "ItemEmptyStmt",
      "ItemSelectedItemStmt",
      "ItemSpecialStmt"
    ]
  },
  {
    dialect: "pack",
    statementKeywords: ["formats", "overlay", "filter"],
    statementKinds: ["PackFormatsStmt", "PackOverlayStmt", "PackFilterBlockStmt"]
  },
  {
    dialect: "atlas",
    statementKeywords: ["directory", "filter", "paletted_permutations"],
    statementKinds: ["AtlasDirectoryStmt", "AtlasFilterStmt", "AtlasPalettedPermutationsStmt"]
  },
  {
    dialect: "mcmeta",
    statementKeywords: ["texture"],
    statementKinds: []
  },
  {
    dialect: "equipment",
    statementKeywords: ["layer"],
    statementKinds: ["EquipmentLayerStmt"]
  }
] as const satisfies readonly LegacyResourceBodyDialectDescriptor[];

const dialectByStatementKind = new Map<ResourceStatementNode["kind"], RsglResourceBodyDialect>(
  legacyResourceBodyDialectDescriptors.flatMap(descriptor =>
    descriptor.statementKinds.map(kind => [kind, descriptor.dialect] as const)
  )
);

const dialectsByStatementKeyword = new Map<string, RsglResourceBodyDialect[]>();
for (const descriptor of legacyResourceBodyDialectDescriptors) {
  for (const keyword of descriptor.statementKeywords) {
    const dialects = dialectsByStatementKeyword.get(keyword) ?? [];
    if (!dialects.includes(descriptor.dialect)) {
      dialects.push(descriptor.dialect);
    }
    dialectsByStatementKeyword.set(keyword, dialects);
  }
}

export function getLegacyResourceBodyDialectForStatementKind(
  kind: ResourceStatementNode["kind"]
): RsglResourceBodyDialect | undefined {
  return dialectByStatementKind.get(kind);
}

/**
 * Resolves dialect evidence that depends on statement payload as well as its
 * discriminant. Most specialized statements have a dedicated kind, but the
 * legacy mcmeta `texture { ... }` form intentionally reuses SectionStmt.
 */
export function getLegacyResourceBodyDialectForStatement(
  statement: ResourceStatementNode
): RsglResourceBodyDialect | undefined {
  if (statement.kind === "SectionStmt" && statement.name.text === "texture") {
    return "mcmeta";
  }
  return getLegacyResourceBodyDialectForStatementKind(statement.kind);
}

const resourceBodyNeutralKeywords = new Set([
  "let",
  "use",
  "for",
  "if",
  "else"
]);

const definiteTopLevelDeclarationKeywords = new Set([
  "target",
  "namespace",
  "import",
  "export",
  "table",
  "template"
]);

/**
 * Selects the parser grammar for a no-arrow template from definition-local
 * syntax only. The semantic layer still owns resolved output metadata.
 *
 * Resource declarations win over body evidence so complete-resource
 * templates keep their Block AST even when their resource bodies contain
 * specialized statements. Otherwise the first specialized body statement
 * selects a precise legacy dialect; generic statements select a generic
 * ResourceBody so control-flow-wrapped custom fields remain recoverable.
 */
export function legacyTemplateBodyParsePlan(
  tokens: readonly RsglToken[],
  openBraceIndex: number
): LegacyTemplateBodyParsePlan {
  let depth = 0;
  let hasResourceDeclaration = false;
  let hasGenericBodyStatement = false;
  const detectedDialects: RsglResourceBodyDialect[] = [];
  let hasAmbiguousOverlay = false;

  for (let index = openBraceIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === "{") {
      depth++;
      continue;
    }
    if (token.text === "}") {
      depth--;
      if (depth <= 0) {
        break;
      }
      continue;
    }
    if (depth <= 0 || !isStatementStart(tokens, index, openBraceIndex)) {
      continue;
    }

    const nextText = tokens[index + 1]?.text ?? "";
    if (nextText === ":" || nextText === "=") {
      hasGenericBodyStatement = true;
      continue;
    }
    if (resourceBodyNeutralKeywords.has(token.text)) {
      continue;
    }
    if (definiteTopLevelDeclarationKeywords.has(token.text)) {
      hasResourceDeclaration = true;
      continue;
    }
    if (token.text === "extern") {
      const modifierOffset = nextText === "!" ? 2 : 1;
      if (tokens[index + modifierOffset]?.text === "var") {
        addDetectedDialect(detectedDialects, "model");
      } else {
        hasResourceDeclaration = true;
      }
      continue;
    }
    if (token.text === "overlay") {
      // `overlay <dir> { ... }` is shared by top-level overlays and pack-body
      // sugar. Preserve the former unless other definition-local evidence
      // selects the pack dialect.
      hasAmbiguousOverlay = true;
      continue;
    }
    if (isRsglResourceKind(token.text)) {
      if (token.text === "model" && !looksLikeModelResourceDeclaration(tokens, index)) {
        // `model <id>` is the ordinary item-body field, while
        // `model block|item <id> {` is a resource declaration.
        addDetectedDialect(detectedDialects, "item");
      } else {
        hasResourceDeclaration = true;
      }
      continue;
    }

    const dialect = legacyDialectForStatement(tokens, index);
    if (dialect) {
      addDetectedDialect(detectedDialects, dialect);
      continue;
    }
    if (isPotentialBodyStatementToken(token)) {
      hasGenericBodyStatement = true;
    }
  }

  if (hasResourceDeclaration) {
    return { kind: "block" };
  }
  if (hasAmbiguousOverlay) {
    addDetectedDialect(detectedDialects, "pack");
  }
  if (detectedDialects.length > 0) {
    return {
      kind: "resourceBody",
      dialect: detectedDialects[0],
      detectedDialects
    };
  }
  return hasGenericBodyStatement
    ? { kind: "resourceBody", dialect: "generic", detectedDialects: ["generic"] }
    : { kind: "block" };
}

function legacyDialectForStatement(
  tokens: readonly RsglToken[],
  index: number
): RsglResourceBodyDialect | undefined {
  const text = tokens[index].text;
  const nextText = tokens[index + 1]?.text ?? "";
  if (text === "variants" || text === "multipart") {
    return "blockstate";
  }
  if (text === "texture") {
    return nextText === "{" ? "mcmeta" : "model";
  }
  if (text === "filter") {
    return nextText === "{" ? "pack" : "atlas";
  }
  const dialects = dialectsByStatementKeyword.get(text);
  return dialects?.length === 1 ? dialects[0] : undefined;
}

function addDetectedDialect(
  detectedDialects: RsglResourceBodyDialect[],
  dialect: RsglResourceBodyDialect
): void {
  if (!detectedDialects.includes(dialect)) {
    detectedDialects.push(dialect);
  }
}

function looksLikeModelResourceDeclaration(tokens: readonly RsglToken[], index: number): boolean {
  const subtype = tokens[index + 1]?.text;
  if (subtype !== "block" && subtype !== "item") {
    return false;
  }

  // A bare item-body field such as `model block` shares the first two tokens
  // with a model resource declaration. Require a real declaration id on the
  // same statement before looking across lines for an `impl` clause or body.
  const idStart = tokens[index + 2];
  if (
    !idStart
    || idStart.leadingTrivia.some(trivia => trivia.kind === "newline")
    || idStart.text === "impl"
    || idStart.text === "{"
    || idStart.text === "}"
    || idStart.text === ";"
  ) {
    return false;
  }

  let delimiterDepth = 0;
  let sawImpl = false;
  let implExpressionStarted = false;
  for (let cursor = index + 3; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (delimiterDepth === 0) {
      if (token.text === "{") {
        return true;
      }
      if (token.text === ";" || token.text === "}") {
        return false;
      }

      const startsNewLine = token.leadingTrivia.some(trivia => trivia.kind === "newline");
      if (startsNewLine) {
        if (token.text === "impl" && !sawImpl) {
          sawImpl = true;
          continue;
        }
        // Permit `impl` and its expression to be split across lines. Once the
        // expression has started, the only valid following statement-level
        // token for this declaration is its body brace (handled above).
        if (!sawImpl || implExpressionStarted) {
          return false;
        }
      }

      if (token.text === "impl" && !sawImpl) {
        sawImpl = true;
        continue;
      }
    }

    if (sawImpl) {
      implExpressionStarted = true;
    }
    if (token.text === "(" || token.text === "[") {
      delimiterDepth++;
    } else if ((token.text === ")" || token.text === "]") && delimiterDepth > 0) {
      delimiterDepth--;
    }
  }
  return false;
}

function isStatementStart(
  tokens: readonly RsglToken[],
  index: number,
  openBraceIndex: number
): boolean {
  if (index === openBraceIndex + 1) {
    return true;
  }
  const previousText = tokens[index - 1]?.text;
  return previousText === "{"
    || previousText === "}"
    || previousText === ";"
    || tokens[index].leadingTrivia.some(trivia => trivia.kind === "newline");
}

function isPotentialBodyStatementToken(token: RsglToken): boolean {
  return token.kind === "identifier"
    || token.kind === "keyword"
    || token.kind === "string"
    || token.kind === "number"
    || token.kind === "resourceLocation";
}
