import type {
  RsglModule,
  RsglNode,
  RsglToken,
  TextRange
} from "../parser";
import {
  consumeRsglClosingDelimiter,
  createRsglDelimiterStack,
  pushRsglOpeningDelimiter
} from "./delimiterStack";
import { tightOperatorWouldRetokenize } from "./lexicalSafety";

const bodyKinds = new Set([
  "Block",
  "ResourceBody",
  "VariantBody",
  "MultipartBody",
  "BlockstateChoiceBody",
  "ItemSelectBody",
  "ItemRangeBody",
  "ItemCompositeBody",
  "ItemFirstMatchBody",
  "ItemModelTemplateBody",
  "BlockstateVariantsRootBody",
  "BlockstateMultipartRootBody"
]);

const tightRangeKinds = new Set(["ResourceLocationExpr"]);

export interface RsglBodyBracePair {
  openOffset: number;
  closeOffset?: number;
  empty: boolean;
}

export interface RsglFormatterSyntaxFacts {
  bodyOpenOffsets: ReadonlySet<number>;
  bodyBracePairs: readonly RsglBodyBracePair[];
  collectionOpenOffsets: ReadonlySet<number>;
  delimiterDepthByTokenOffset: ReadonlyMap<number, number>;
  tightTokenPairs: ReadonlySet<number>;
  unaryOperatorOffsets: ReadonlySet<number>;
  spacedOperatorOffsets: ReadonlySet<number>;
  indexOpenOffsets: ReadonlySet<number>;
}

export function collectRsglFormatterSyntaxFacts(
  module: RsglModule
): RsglFormatterSyntaxFacts {
  const bodyBracePairs: RsglBodyBracePair[] = [];
  const collectionOpenOffsets = new Set<number>();
  const tightTokenPairs = new Set<number>();
  const unaryOperatorOffsets = new Set<number>();
  const spacedOperatorOffsets = new Set<number>();
  const indexOpenOffsets = new Set<number>();
  const tokens = module.tokens.filter(token => token.kind !== "endOfFile");
  const tokenIndex = createTokenIndex(tokens);

  visitAstValue(module.statements, node => {
    if (bodyKinds.has(node.kind)) {
      const pair = bracePairWithin(
        tokenIndex,
        node.range,
        nodeArrayProperty(node, "statements").length === 0
      );
      if (pair) {
        bodyBracePairs.push(pair);
      }
    } else if (node.kind === "MatchExpr") {
      const expression = nodeProperty<RsglNode>(node, "expression");
      const pair = bracePairWithin(
        tokenIndex,
        node.range,
        nodeArrayProperty(node, "arms").length === 0,
        expression?.range.end
      );
      if (pair) {
        bodyBracePairs.push(pair);
      }
    }

    if (tightRangeKinds.has(node.kind)) {
      markTightPairs(tokenIndex, node.range, tightTokenPairs);
    } else if (node.kind === "ExternPattern") {
      markOriginallyTightPairs(tokenIndex, node.range, tightTokenPairs);
    }

    switch (node.kind) {
      case "ExternDecl": {
        if (nodeProperty<boolean>(node, "skipExistenceCheck")) {
          markExternBangSpacing(
            tokenIndex,
            node.range,
            tightTokenPairs,
            spacedOperatorOffsets
          );
        }
        break;
      }
      case "UnaryExpr":
        markFirstTokenInRange(tokenIndex, node.range, unaryOperatorOffsets);
        break;
      case "BinaryExpr": {
        const left = nodeProperty<RsglNode>(node, "left");
        const right = nodeProperty<RsglNode>(node, "right");
        markTokenBetween(tokenIndex, left?.range.end, right?.range.start, spacedOperatorOffsets);
        break;
      }
      case "RangeExpr": {
        const start = nodeProperty<RsglNode>(node, "startExpr");
        const end = nodeProperty<RsglNode>(node, "endExpr");
        markOperatorSpacing(
          tokenIndex,
          start?.range.end,
          end?.range.start,
          tightTokenPairs,
          spacedOperatorOffsets,
          ".."
        );
        break;
      }
      case "ConditionalExpr": {
        const condition = nodeProperty<RsglNode>(node, "condition");
        const whenTrue = nodeProperty<RsglNode>(node, "whenTrue");
        const whenFalse = nodeProperty<RsglNode>(node, "whenFalse");
        markTokenBetween(tokenIndex, condition?.range.end, whenTrue?.range.start, spacedOperatorOffsets);
        markTokenBetween(tokenIndex, whenTrue?.range.end, whenFalse?.range.start, spacedOperatorOffsets);
        break;
      }
      case "LambdaExpr": {
        const body = nodeProperty<RsglNode>(node, "body");
        markLastTokenBefore(tokenIndex, body?.range.start, node.range, spacedOperatorOffsets, "=>");
        break;
      }
      case "CallExpr": {
        const callee = nodeProperty<RsglNode>(node, "callee");
        markTightBeforeToken(
          tokenIndex,
          callee?.range.end,
          node.range.end,
          tightTokenPairs,
          "("
        );
        break;
      }
      case "IndexExpr": {
        const object = nodeProperty<RsglNode>(node, "object");
        const opener = tokenBetween(tokenIndex, object?.range.end, node.range.end, "[");
        if (opener) {
          indexOpenOffsets.add(opener.offset);
        }
        break;
      }
      case "MemberExpr": {
        const object = nodeProperty<RsglNode>(node, "object");
        const property = nodeProperty<RsglNode>(node, "property");
        markOperatorSpacing(
          tokenIndex,
          object?.range.end,
          property?.range.start,
          tightTokenPairs,
          spacedOperatorOffsets,
          "."
        );
        break;
      }
      case "ModelTransformStmt": {
        const operation = nodeProperty<RsglNode>(node, "operation");
        const angle = nodeProperty<RsglNode>(node, "angle");
        markTightAroundToken(
          tokenIndex,
          operation?.range.end,
          angle?.range.start,
          tightTokenPairs,
          "("
        );
        break;
      }
      case "GenericType":
        markGenericAngleSpacing(tokenIndex, node.range, tightTokenPairs);
        break;
    }
  });

  const bodyOpenOffsets = new Set(bodyBracePairs.map(pair => pair.openOffset));
  for (const token of tokens) {
    if (
      (token.text === "(" || token.text === "[" || token.text === "{")
      && !bodyOpenOffsets.has(token.offset)
    ) {
      collectionOpenOffsets.add(token.offset);
    }
  }
  const delimiterDepthByTokenOffset = collectDelimiterDepths(tokens);

  return {
    bodyOpenOffsets,
    bodyBracePairs,
    collectionOpenOffsets,
    delimiterDepthByTokenOffset,
    tightTokenPairs,
    unaryOperatorOffsets,
    spacedOperatorOffsets,
    indexOpenOffsets
  };
}

function visitAstValue(value: unknown, visitor: (node: RsglNode) => void): void {
  if (Array.isArray(value)) {
    value.forEach(item => visitAstValue(item, visitor));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isNode(value)) {
    visitor(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "range"
      || key === "fullRange"
      || key === "tokens"
      || key === "diagnostics"
      || key === "leadingTrivia"
    ) {
      continue;
    }
    visitAstValue(child, visitor);
  }
}

function bracePairWithin(
  index: SyntaxTokenIndex,
  range: TextRange,
  empty: boolean,
  minimumOffset = range.start
): RsglBodyBracePair | undefined {
  const openIndex = findTokenIndex(index, minimumOffset, range.end, "{");
  if (openIndex < 0) {
    return undefined;
  }
  const open = index.tokens[openIndex];
  let depth = 0;
  for (let tokenPosition = openIndex; tokenPosition < index.tokens.length; tokenPosition++) {
    const token = index.tokens[tokenPosition];
    if (token.offset >= range.end) {
      break;
    }
    if (token.text === "{") {
      depth++;
    } else if (token.text === "}") {
      depth--;
      if (depth === 0) {
        return { openOffset: open.offset, closeOffset: token.offset, empty };
      }
    }
  }
  return { openOffset: open.offset, empty };
}

function markTightPairs(
  index: SyntaxTokenIndex,
  range: TextRange,
  result: Set<number>
): void {
  const start = firstTokenIndexAtOrAfter(index, range.start);
  let previous: RsglToken | undefined;
  for (let position = start; position < index.tokens.length; position++) {
    const token = index.tokens[position];
    if (token.offset + token.length > range.end) {
      break;
    }
    if (previous) {
      result.add(previous.offset);
    }
    previous = token;
  }
}

function markOriginallyTightPairs(
  index: SyntaxTokenIndex,
  range: TextRange,
  result: Set<number>
): void {
  const start = firstTokenIndexAtOrAfter(index, range.start);
  let previous: RsglToken | undefined;
  for (let position = start; position < index.tokens.length; position++) {
    const token = index.tokens[position];
    if (token.offset + token.length > range.end) {
      break;
    }
    if (previous && previous.offset + previous.length === token.offset) {
      result.add(previous.offset);
    }
    previous = token;
  }
}

function markExternBangSpacing(
  index: SyntaxTokenIndex,
  range: TextRange,
  tightResult: Set<number>,
  spacedResult: Set<number>
): void {
  const bangPosition = findTokenIndex(index, range.start, range.end, "!");
  if (bangPosition <= 0) {
    return;
  }
  const previous = index.tokens[bangPosition - 1];
  const bang = index.tokens[bangPosition];
  if (
    previous.text === "extern"
    && previous.offset + previous.length === bang.offset
  ) {
    tightResult.add(previous.offset);
    spacedResult.add(bang.offset);
  }
}

function markFirstTokenInRange(
  index: SyntaxTokenIndex,
  range: TextRange,
  result: Set<number>
): void {
  const position = firstTokenIndexAtOrAfter(index, range.start);
  const token = index.tokens[position]?.offset < range.end
    ? index.tokens[position]
    : undefined;
  if (token) {
    result.add(token.offset);
  }
}

function markGenericAngleSpacing(
  index: SyntaxTokenIndex,
  range: TextRange,
  result: Set<number>
): void {
  const openPosition = findTokenIndex(index, range.start, range.end, "<");
  if (openPosition <= 0) {
    return;
  }
  let depth = 0;
  let closePosition = -1;
  for (let position = openPosition; position < index.tokens.length; position++) {
    const token = index.tokens[position];
    if (token.offset >= range.end) {
      break;
    }
    if (token.text === "<") {
      depth++;
    } else if (token.text === ">") {
      depth--;
      if (depth === 0) {
        closePosition = position;
        break;
      }
    }
  }
  if (closePosition < 0) {
    return;
  }
  result.add(index.tokens[openPosition - 1].offset);
  result.add(index.tokens[openPosition].offset);
  if (openPosition + 1 < closePosition) {
    result.add(index.tokens[closePosition - 1].offset);
  }
}

function markTightAroundToken(
  index: SyntaxTokenIndex,
  start: number | undefined,
  end: number | undefined,
  result: Set<number>,
  text: string
): void {
  if (start === undefined || end === undefined) {
    return;
  }
  const position = findTokenIndex(index, start, end, text);
  if (position < 0) {
    return;
  }
  const previous = index.tokens[position - 1];
  const next = index.tokens[position + 1];
  if (previous && previous.offset + previous.length <= index.tokens[position].offset) {
    result.add(previous.offset);
  }
  if (next && next.offset <= end) {
    result.add(index.tokens[position].offset);
  }
}

function markTightBeforeToken(
  index: SyntaxTokenIndex,
  start: number | undefined,
  end: number | undefined,
  result: Set<number>,
  text: string
): void {
  if (start === undefined || end === undefined) {
    return;
  }
  const position = findTokenIndex(index, start, end, text);
  const previous = index.tokens[position - 1];
  if (position >= 0 && previous) {
    result.add(previous.offset);
  }
}

function markOperatorSpacing(
  index: SyntaxTokenIndex,
  start: number | undefined,
  end: number | undefined,
  tightResult: Set<number>,
  spacedResult: Set<number>,
  text: string
): void {
  if (start === undefined || end === undefined) {
    return;
  }
  const position = findTokenIndex(index, start, end, text);
  const left = index.tokens[position - 1];
  const operator = index.tokens[position];
  const right = index.tokens[position + 1];
  if (
    position < 0
    || !left
    || !operator
    || !right
    || right.offset > end
    || tightOperatorWouldRetokenize(left, operator, right)
  ) {
    if (operator) {
      spacedResult.add(operator.offset);
    }
    return;
  }
  tightResult.add(left.offset);
  tightResult.add(operator.offset);
}

function markTokenBetween(
  index: SyntaxTokenIndex,
  start: number | undefined,
  end: number | undefined,
  result: Set<number>
): void {
  const token = tokenBetween(index, start, end);
  if (token) {
    result.add(token.offset);
  }
}

function markLastTokenBefore(
  index: SyntaxTokenIndex,
  end: number | undefined,
  range: TextRange,
  result: Set<number>,
  text: string
): void {
  if (end === undefined) {
    return;
  }
  let position = firstTokenIndexAtOrAfter(index, end) - 1;
  let token: RsglToken | undefined;
  for (; position >= 0; position--) {
    const candidate = index.tokens[position];
    if (candidate.offset < range.start) {
      break;
    }
    if (candidate.text === text) {
      token = candidate;
      break;
    }
  }
  if (token) {
    result.add(token.offset);
  }
}

function tokenBetween(
  index: SyntaxTokenIndex,
  start: number | undefined,
  end: number | undefined,
  text?: string
): RsglToken | undefined {
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const position = findTokenIndex(index, start, end, text);
  return position >= 0 ? index.tokens[position] : undefined;
}

function nodeProperty<T>(node: RsglNode, key: string): T | undefined {
  return (node as unknown as Record<string, unknown>)[key] as T | undefined;
}

function nodeArrayProperty(node: RsglNode, key: string): readonly unknown[] {
  const value = nodeProperty<unknown>(node, key);
  return Array.isArray(value) ? value : [];
}

function isNode(value: Record<string, unknown>): value is RsglNode & Record<string, unknown> {
  return typeof value.kind === "string"
    && isRange(value.range)
    && isRange(value.fullRange);
}

function isRange(value: unknown): value is TextRange {
  return isRecord(value)
    && typeof value.start === "number"
    && typeof value.end === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SyntaxTokenIndex {
  tokens: readonly RsglToken[];
}

function createTokenIndex(tokens: readonly RsglToken[]): SyntaxTokenIndex {
  return { tokens };
}

function collectDelimiterDepths(
  tokens: readonly RsglToken[]
): ReadonlyMap<number, number> {
  const delimiters = createRsglDelimiterStack();
  const result = new Map<number, number>();

  for (const token of tokens) {
    if (consumeRsglClosingDelimiter(delimiters, token.text)) {
      result.set(token.offset, delimiters.expectedClosers.length);
      continue;
    }
    result.set(token.offset, delimiters.expectedClosers.length);
    pushRsglOpeningDelimiter(delimiters, token.text);
  }
  return result;
}

function findTokenIndex(
  index: SyntaxTokenIndex,
  start: number,
  end: number,
  text?: string
): number {
  for (
    let position = firstTokenIndexAtOrAfter(index, start);
    position < index.tokens.length && index.tokens[position].offset < end;
    position++
  ) {
    if (text === undefined || index.tokens[position].text === text) {
      return position;
    }
  }
  return -1;
}

function firstTokenIndexAtOrAfter(index: SyntaxTokenIndex, offset: number): number {
  let low = 0;
  let high = index.tokens.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (index.tokens[middle].offset < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
