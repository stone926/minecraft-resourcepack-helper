import type {
  ArgumentNode,
  BlockstateModelPropertyNode,
  IdentifierNode,
  ImportDeclNode,
  MemberExprNode,
  ObjectPropertyNode,
  PropertyStmtNode,
  ResourceDeclNode,
  RsglNode,
  SugarPropertyNode,
  TextRange
} from "./parser";
import type { RsglReferenceRecord, RsglSemanticModel, RsglSymbol } from "./semantic";

/**
 * Semantic token legend shared by every RSGL transport (LSP server and the
 * in-process VS Code providers). Only standard VS Code token types and
 * modifiers are used so themes color RSGL without any contribution points.
 */
export const rsglSemanticTokenTypes: readonly string[] = [
  "namespace",
  "type",
  "function",
  "variable",
  "parameter",
  "property"
];

export const rsglSemanticTokenModifiers: readonly string[] = [
  "declaration",
  "readonly",
  "defaultLibrary"
];

/**
 * A single resolved semantic token. `tokenType` indexes into
 * {@link rsglSemanticTokenTypes} and `tokenModifiers` is a bitmask over
 * {@link rsglSemanticTokenModifiers}.
 *
 * Tokens are always single-line: every token range covers exactly one RSGL
 * identifier, and the lexer only accepts `[A-Za-z_][A-Za-z0-9_]*` for
 * identifiers, so a token can never span a line break.
 */
export interface RsglSemanticToken {
  start: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

const namespaceTokenType = rsglSemanticTokenTypes.indexOf("namespace");
const typeTokenType = rsglSemanticTokenTypes.indexOf("type");
const functionTokenType = rsglSemanticTokenTypes.indexOf("function");
const variableTokenType = rsglSemanticTokenTypes.indexOf("variable");
const parameterTokenType = rsglSemanticTokenTypes.indexOf("parameter");
const propertyTokenType = rsglSemanticTokenTypes.indexOf("property");

const declarationModifier = 1 << rsglSemanticTokenModifiers.indexOf("declaration");
const readonlyModifier = 1 << rsglSemanticTokenModifiers.indexOf("readonly");
const defaultLibraryModifier = 1 << rsglSemanticTokenModifiers.indexOf("defaultLibrary");

interface RsglTokenClassification {
  tokenType: number;
  tokenModifiers: number;
}

/** Computes the semantic highlighting tokens for one bound RSGL module. */
export function getRsglSemanticTokens(model: RsglSemanticModel): RsglSemanticToken[] {
  const candidates: RsglSemanticToken[] = [];
  const referenceStarts = collectReferenceStarts(model.references);

  collectPropertyTokens(model.module, candidates);
  for (const record of model.imports) {
    collectImportDeclarationTokens(record.node, model, candidates);
  }
  for (const symbol of model.symbols) {
    collectDeclarationToken(symbol, referenceStarts, candidates);
  }
  for (const reference of model.references) {
    collectReferenceToken(reference, candidates);
  }

  return normalizeTokens(candidates);
}

/** Emits AST-backed property tokens without guessing context from keywords. */
function collectPropertyTokens(root: RsglNode, candidates: RsglSemanticToken[]): void {
  visitPropertyContainer(root, candidates, new WeakSet<object>());
}

function visitPropertyContainer(
  value: unknown,
  candidates: RsglSemanticToken[],
  seen: WeakSet<object>
): void {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => visitPropertyContainer(item, candidates, seen));
    return;
  }

  if (isRsglNode(value)) {
    for (const identifier of propertyIdentifiers(value)) {
      if (isSemanticIdentifier(identifier)) {
        pushToken(candidates, identifier.range, { tokenType: propertyTokenType, tokenModifiers: 0 }, 0);
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (!nonAstContainerKeys.has(key)) {
      visitPropertyContainer(child, candidates, seen);
    }
  }
}

const nonAstContainerKeys = new Set(["range", "fullRange", "tokens", "eof", "diagnostics", "leadingTrivia"]);

function isRsglNode(value: object): value is RsglNode {
  return "kind" in value && "range" in value && "fullRange" in value;
}

function isSemanticIdentifier(identifier: IdentifierNode): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier.text)
    && identifier.range.end - identifier.range.start === identifier.text.length;
}

function propertyIdentifiers(node: RsglNode): readonly IdentifierNode[] {
  switch (node.kind) {
    case "ObjectProperty": {
      const key = (node as ObjectPropertyNode).key;
      return key.kind === "Identifier" ? [key] : [];
    }
    case "Argument": {
      const name = (node as ArgumentNode).name;
      return name ? [name] : [];
    }
    case "MemberExpr":
      return [(node as MemberExprNode).property];
    case "SugarProperty":
      return [(node as SugarPropertyNode).name];
    case "BlockstateModelProperty":
      return [(node as BlockstateModelPropertyNode).name];
    case "PropertyStmt":
      return [(node as PropertyStmtNode).name];
    default:
      return [];
  }
}

/** Maps a resolved symbol onto the shared legend; null means "do not highlight". */
function classifySymbol(symbol: RsglSymbol): RsglTokenClassification | null {
  if (symbol.kind === "builtin") {
    return {
      tokenType: symbol.type.kind === "Function" ? functionTokenType : variableTokenType,
      tokenModifiers: defaultLibraryModifier
    };
  }
  if (symbol.kind === "template") {
    return { tokenType: functionTokenType, tokenModifiers: 0 };
  }
  if (symbol.kind === "variable") {
    return { tokenType: variableTokenType, tokenModifiers: readonlyModifier };
  }
  if (symbol.kind === "table") {
    return { tokenType: variableTokenType, tokenModifiers: 0 };
  }
  if (symbol.kind === "parameter") {
    return { tokenType: parameterTokenType, tokenModifiers: 0 };
  }
  if (symbol.kind === "namespace") {
    return { tokenType: namespaceTokenType, tokenModifiers: 0 };
  }
  if (symbol.kind === "import") {
    return {
      tokenType: symbol.type.kind === "Function" ? functionTokenType : variableTokenType,
      tokenModifiers: 0
    };
  }
  return { tokenType: typeTokenType, tokenModifiers: 0 };
}

function collectReferenceStarts(references: readonly RsglReferenceRecord[]): Set<number> {
  const starts = new Set<number>();
  for (const reference of references) {
    if (reference.symbol && isTokenizableRange(reference.range)) {
      starts.add(reference.range.start);
    }
  }
  return starts;
}

/**
 * Emits declaration tokens for the local names introduced by an import
 * declaration (`import fallback from "..."` / `import { a as b } from "..."`).
 * The AST node is used instead of the symbol table because `import *` links
 * synthetic symbols whose ranges point at the source string literal.
 */
function collectImportDeclarationTokens(
  node: ImportDeclNode,
  model: RsglSemanticModel,
  candidates: RsglSemanticToken[]
): void {
  if (node.defaultName) {
    pushToken(candidates, node.defaultName.range, importClassification(model, node.defaultName.text), declarationModifier);
  }
  for (const specifier of node.namedImports) {
    pushToken(candidates, specifier.local.range, importClassification(model, specifier.local.text), declarationModifier);
  }
}

/**
 * Classifies an imported local name by the linked symbol's shape: templates
 * and other callables highlight as functions, everything else as variables.
 * Before program linking resolves the underlying export, imports default to
 * the variable classification.
 */
function importClassification(model: RsglSemanticModel, name: string): RsglTokenClassification {
  const symbol = model.scope.symbols.get(name);
  if (symbol && symbol.kind === "import") {
    return classifySymbol(symbol) ?? { tokenType: variableTokenType, tokenModifiers: 0 };
  }
  return { tokenType: variableTokenType, tokenModifiers: 0 };
}

function collectDeclarationToken(
  symbol: RsglSymbol,
  referenceStarts: ReadonlySet<number>,
  candidates: RsglSemanticToken[]
): void {
  if (symbol.kind === "import" || symbol.kind === "builtin" || !symbol.range) {
    return;
  }
  if (symbol.kind === "resource" && !isResourceNameToken(symbol, referenceStarts)) {
    return;
  }
  const classification = classifySymbol(symbol);
  if (classification) {
    pushToken(candidates, symbol.range, classification, declarationModifier);
  }
}

/**
 * Resource declarations only get a name token when the declared id is a bare
 * identifier (`model block acacia_planks { ... }`). Ids written as strings or
 * resource locations stay with the TextMate grammar, and ids bound to an
 * in-scope variable/parameter keep their reference token instead.
 */
function isResourceNameToken(symbol: RsglSymbol, referenceStarts: ReadonlySet<number>): boolean {
  const node = symbol.node;
  if (!node || node.kind !== "ResourceDecl" || !symbol.range) {
    return false;
  }
  const id = (node as ResourceDeclNode).id;
  return id?.kind === "IdentifierExpr" && !referenceStarts.has(symbol.range.start);
}

function collectReferenceToken(reference: RsglReferenceRecord, candidates: RsglSemanticToken[]): void {
  if (!reference.symbol) {
    return;
  }
  const classification = classifySymbol(reference.symbol);
  if (classification) {
    pushToken(candidates, reference.range, classification, 0);
  }
}

function pushToken(
  candidates: RsglSemanticToken[],
  range: TextRange,
  classification: RsglTokenClassification,
  extraModifiers: number
): void {
  if (!isTokenizableRange(range)) {
    return;
  }
  candidates.push({
    start: range.start,
    length: range.end - range.start,
    tokenType: classification.tokenType,
    tokenModifiers: classification.tokenModifiers | extraModifiers
  });
}

/** Rejects synthetic, negative, or empty ranges produced by parse recovery. */
function isTokenizableRange(range: TextRange | undefined): range is TextRange {
  return range !== undefined && range.start >= 0 && range.end > range.start;
}

/**
 * Sorts tokens by offset and drops duplicates and overlaps deterministically:
 * on identical or overlapping ranges the declaration-modified token wins,
 * then the lower token type, then the smaller modifier set.
 */
function normalizeTokens(candidates: RsglSemanticToken[]): RsglSemanticToken[] {
  const sorted = [...candidates].sort((left, right) =>
    left.start - right.start ||
    declarationRank(right) - declarationRank(left) ||
    left.tokenType - right.tokenType ||
    left.tokenModifiers - right.tokenModifiers
  );

  const tokens: RsglSemanticToken[] = [];
  let lastEnd = -1;
  for (const token of sorted) {
    if (token.start < lastEnd) {
      continue;
    }
    tokens.push(token);
    lastEnd = token.start + token.length;
  }
  return tokens;
}

function declarationRank(token: RsglSemanticToken): number {
  return (token.tokenModifiers & declarationModifier) !== 0 ? 1 : 0;
}
