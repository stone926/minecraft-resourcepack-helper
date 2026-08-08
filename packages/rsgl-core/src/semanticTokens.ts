import type {
  ArgumentNode,
  ExportDeclNode,
  ForObjectBindingPropertyNode,
  IdentifierNode,
  ImportDeclNode,
  ItemOptionNode,
  MemberExprNode,
  ObjectPropertyNode,
  PropertyStmtNode,
  ResourceDeclNode,
  RsglNode,
  TextRange
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import type { RsglReferenceRecord, RsglSemanticModel, RsglSymbol } from "./semantic";
import { resolveModuleNamespaceExpressionMember } from "./semantic/moduleNamespace";
import {
  getRsglSemanticOccurrences,
  type RsglSemanticOccurrenceProgram
} from "./semanticOccurrences";

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
  readonly start: number;
  readonly length: number;
  readonly tokenType: number;
  readonly tokenModifiers: number;
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

interface RsglSemanticTokenCacheEntry {
  standalone?: readonly RsglSemanticToken[];
  readonly byProgram: WeakMap<object, readonly RsglSemanticToken[]>;
}

const tokensBySemanticModel = new WeakMap<RsglSemanticModel, RsglSemanticTokenCacheEntry>();

/** Computes the semantic highlighting tokens for one bound RSGL module. */
export function getRsglSemanticTokens(
  model: RsglSemanticModel,
  program?: RsglSemanticOccurrenceProgram
): readonly RsglSemanticToken[] {
  const cache = semanticTokenCacheEntry(model);
  const cached = program ? cache.byProgram.get(program) : cache.standalone;
  if (cached) {
    return cached;
  }
  const candidates: RsglSemanticToken[] = [];
  const referenceStarts = collectReferenceStarts(model.references);
  const specifierClassifications = collectModuleSpecifierClassifications(
    program ?? standaloneOccurrenceProgram(model),
    model
  );

  collectTypeAliasTokens(model, candidates);
  collectPropertyTokens(model.module, candidates);
  collectTextureVariableLiteralTokens(model, candidates);
  collectModuleNamespaceMemberTokens(model, candidates);
  for (const record of model.imports) {
    collectImportDeclarationTokens(record.node, model, specifierClassifications, candidates);
  }
  for (const record of model.exports) {
    collectExportSpecifierTokens(record.node, model, specifierClassifications, candidates);
  }
  for (const symbol of model.symbols) {
    collectDeclarationToken(symbol, referenceStarts, candidates);
  }
  for (const reference of model.references) {
    collectReferenceToken(reference, candidates);
  }

  const tokens = Object.freeze(normalizeTokens(candidates));
  if (program) {
    cache.byProgram.set(program, tokens);
  } else {
    cache.standalone = tokens;
  }
  return tokens;
}

function semanticTokenCacheEntry(model: RsglSemanticModel): RsglSemanticTokenCacheEntry {
  const cached = tokensBySemanticModel.get(model);
  if (cached) {
    return cached;
  }
  const entry: RsglSemanticTokenCacheEntry = { byProgram: new WeakMap() };
  tokensBySemanticModel.set(model, entry);
  return entry;
}

function standaloneOccurrenceProgram(model: RsglSemanticModel): RsglSemanticOccurrenceProgram {
  return {
    models: [model],
    importGraph: {
      files: [model.fileName],
      edges: [],
      cycles: [],
      missing: []
    }
  };
}

/** Emits aliases from the type namespace, which is separate from value symbols. */
function collectTypeAliasTokens(model: RsglSemanticModel, candidates: RsglSemanticToken[]): void {
  walkRsglModule(model.module, {
    enterStatement(statement) {
      if (statement.kind === "TypeAliasDecl" && statement.name && isSemanticIdentifier(statement.name)) {
        pushToken(candidates, statement.name.range, { tokenType: typeTokenType, tokenModifiers: 0 }, declarationModifier);
      }
    },
    enterType(type) {
      if ((type.kind === "NamedType" || type.kind === "GenericType")
        && model.scope.typeAliases.has(type.name.text)) {
        pushToken(candidates, type.name.range, { tokenType: typeTokenType, tokenModifiers: 0 }, 0);
      }
    }
  });
}

/** Overrides generic property coloring with the linked export's category. */
function collectModuleNamespaceMemberTokens(
  model: RsglSemanticModel,
  candidates: RsglSemanticToken[]
): void {
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind !== "MemberExpr") {
        return;
      }
      const member = resolveModuleNamespaceExpressionMember(model, expression)?.member;
      const classification = member ? classifySymbol(member.symbol) : null;
      if (classification) {
        pushToken(candidates, expression.property.range, classification, 0);
      }
    }
  });
}

/** Emits AST-backed property tokens without guessing context from keywords. */
function collectPropertyTokens(root: RsglNode, candidates: RsglSemanticToken[]): void {
  visitPropertyContainer(root, candidates, new WeakSet<object>());
}

function collectTextureVariableLiteralTokens(
  model: RsglSemanticModel,
  candidates: RsglSemanticToken[]
): void {
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind === "TextureVariableLiteral" && isSemanticIdentifier(expression.name)) {
        pushToken(
          candidates,
          expression.name.range,
          { tokenType: variableTokenType, tokenModifiers: 0 },
          0
        );
      }
    }
  });
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
    case "ForObjectBindingProperty":
      return [(node as ForObjectBindingPropertyNode).property];
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
    case "PropertyStmt":
      return (node as PropertyStmtNode).key.kind === "Identifier"
        ? [(node as PropertyStmtNode).key as IdentifierNode]
        : [];
    case "ItemOption":
      return [(node as ItemOptionNode).name];
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
    return {
      tokenType: symbol.type.kind === "Function" ? functionTokenType : variableTokenType,
      tokenModifiers: readonlyModifier
    };
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

function collectModuleSpecifierClassifications(
  program: RsglSemanticOccurrenceProgram,
  model: RsglSemanticModel
): ReadonlyMap<string, RsglTokenClassification> {
  const classifications = new Map<
    string,
    { classification: RsglTokenClassification; priority: number }
  >();
  for (const occurrence of getRsglSemanticOccurrences(program, model)) {
    const classification = occurrence.kind === "typeAlias"
      ? { tokenType: typeTokenType, tokenModifiers: 0 }
      : classifySymbol(occurrence.symbol);
    if (!classification) {
      continue;
    }
    const key = rangeKey(occurrence.range);
    const priority = occurrence.kind === "value" ? 1 : 0;
    const existing = classifications.get(key);
    if (!existing || priority > existing.priority) {
      classifications.set(key, { classification, priority });
    }
  }
  return new Map(Array.from(classifications, ([key, value]) => [key, value.classification]));
}

function rangeKey(range: TextRange): string {
  return `${range.start}\0${range.end}`;
}

function classificationAt(
  classifications: ReadonlyMap<string, RsglTokenClassification>,
  range: TextRange
): RsglTokenClassification | undefined {
  return classifications.get(rangeKey(range));
}

/**
 * Emits resolved source names and declaration tokens for the local names
 * introduced by an import declaration. Type-only imports are classified from
 * the linked type namespace instead of being flattened into value variables.
 */
function collectImportDeclarationTokens(
  node: ImportDeclNode,
  model: RsglSemanticModel,
  classifications: ReadonlyMap<string, RsglTokenClassification>,
  candidates: RsglSemanticToken[]
): void {
  if (node.defaultName) {
    pushToken(candidates, node.defaultName.range, importClassification(model, node.defaultName.text), declarationModifier);
  }
  if (node.namespaceName) {
    pushToken(
      candidates,
      node.namespaceName.range,
      { tokenType: namespaceTokenType, tokenModifiers: 0 },
      declarationModifier
    );
  }
  for (const specifier of node.namedImports) {
    const classification = classificationAt(classifications, specifier.local.range)
      ?? classificationAt(classifications, specifier.imported.range)
      ?? importClassification(model, specifier.local.text);
    pushToken(candidates, specifier.imported.range, classification, 0);
    pushToken(candidates, specifier.local.range, classification, declarationModifier);
  }
}

/** Emits local exports and re-exports using the category of their resolved target. */
function collectExportSpecifierTokens(
  node: ExportDeclNode,
  model: RsglSemanticModel,
  classifications: ReadonlyMap<string, RsglTokenClassification>,
  candidates: RsglSemanticToken[]
): void {
  for (const specifier of node.specifiers) {
    const localClassification = classificationAt(classifications, specifier.local.range)
      ?? localExportClassification(model, node, specifier.local.text);
    const exportedClassification = classificationAt(classifications, specifier.exported.range)
      ?? localClassification;
    if (localClassification) {
      pushToken(candidates, specifier.local.range, localClassification, 0);
    }
    if (exportedClassification) {
      pushToken(candidates, specifier.exported.range, exportedClassification, 0);
    }
  }
}

function localExportClassification(
  model: RsglSemanticModel,
  node: ExportDeclNode,
  name: string
): RsglTokenClassification | null {
  if (node.source) {
    return null;
  }
  const valueSymbol = model.scope.symbols.get(name);
  if (valueSymbol) {
    return classifySymbol(valueSymbol);
  }
  return model.scope.typeAliases.has(name)
    ? { tokenType: typeTokenType, tokenModifiers: 0 }
    : null;
}

/**
 * Classifies an imported local name by its linked value or type namespace.
 * Before program linking resolves the underlying export, imports default to
 * the variable classification.
 */
function importClassification(model: RsglSemanticModel, name: string): RsglTokenClassification {
  const symbol = model.scope.symbols.get(name);
  if (symbol && (symbol.kind === "import" || symbol.kind === "namespace")) {
    return classifySymbol(symbol) ?? { tokenType: variableTokenType, tokenModifiers: 0 };
  }
  if (model.scope.typeAliases.has(name)) {
    return { tokenType: typeTokenType, tokenModifiers: 0 };
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
  // Range `frame`/`index` bindings are implicit and therefore use their
  // owning statement as a diagnostic range. They have no declaration
  // identifier to color; emitting that broad range would also suppress real
  // reference tokens contained by the frames statement.
  if (symbol.node?.kind === "ItemRangeFrames"
    && (symbol.name === "frame" || symbol.name === "index")) {
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
