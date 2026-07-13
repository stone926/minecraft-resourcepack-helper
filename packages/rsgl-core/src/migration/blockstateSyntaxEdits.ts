import type {
  ModelApplySugarNode,
  MultipartSectionNode,
  RsglModule,
  RsglToken,
  StateKeySugarNode,
  TextRange,
  VariantEntryNode,
  VariantsSectionNode
} from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import { MigrationSymbolResolution } from "./symbolResolution";
import { applyTextEdits } from "./textEdits";
import type { TextEdit } from "./types";

export type LegacyBlockstateWrapper = VariantsSectionNode | MultipartSectionNode;

export interface CollectedLegacySyntaxEdits {
  edits: TextEdit[];
  unsupportedRange?: TextRange;
}

export function collectLegacyBlockstateSyntaxEdits(
  module: RsglModule,
  tokens: readonly RsglToken[],
  migrationRange: TextRange,
  symbols: MigrationSymbolResolution
): CollectedLegacySyntaxEdits {
  const edits: TextEdit[] = [];
  let unsupportedRange: TextRange | undefined;

  walkRsglModule(module, {
    enterStatement(statement) {
      if (!containsRange(migrationRange, statement.range)) {
        return containsRange(statement.range, migrationRange) ? undefined : "skipChildren";
      }
      if (statement.kind === "VariantEntry") {
        collectLegacyVariantEntryEdits(tokens, statement, edits);
      }
    },
    enterExpression(expression) {
      if (!containsRange(migrationRange, expression.range)) {
        return "skipChildren";
      }
      if (expression.kind === "StateKeySugar") {
        collectStateKeyEdits(tokens, expression, symbols, edits);
      } else if (expression.kind === "ModelApplySugar") {
        unsupportedRange ??= collectModelApplyEdits(tokens, expression, edits);
      }
    }
  });
  return { edits, ...(unsupportedRange ? { unsupportedRange } : {}) };
}

export function createWrapperReplacement(
  sourceText: string,
  tokens: readonly RsglToken[],
  wrapper: LegacyBlockstateWrapper,
  nestedEdits: readonly TextEdit[]
): TextEdit | undefined {
  const opening = findSourceToken(tokens, wrapper.range.start, wrapper.range.end, "{");
  const closing = findLastSourceToken(tokens, wrapper.range.start, wrapper.range.end, "}");
  if (!opening || !closing || opening.offset + opening.length > closing.offset) {
    return undefined;
  }

  const innerStart = opening.offset + opening.length;
  const relativeEdits = nestedEdits
    .filter(edit => innerStart <= edit.range.start && edit.range.end <= closing.offset)
    .map(edit => ({
      range: { start: edit.range.start - innerStart, end: edit.range.end - innerStart },
      newText: edit.newText
    }));
  const transformedInner = applyTextEdits(sourceText.slice(innerStart, closing.offset), relativeEdits);
  const lineStart = sourceLineStart(sourceText, wrapper.range.start);
  const leading = sourceText.slice(lineStart, wrapper.range.start);
  const replaceWholeLine = isHorizontalWhitespace(leading);
  return {
    range: {
      start: replaceWholeLine ? lineStart : wrapper.range.start,
      end: closing.offset + closing.length
    },
    newText: normalizeUnwrappedContent(transformedInner, replaceWholeLine ? leading : "")
  };
}

function collectLegacyVariantEntryEdits(
  tokens: readonly RsglToken[],
  entry: VariantEntryNode,
  edits: TextEdit[]
): void {
  const arrow = findSourceToken(tokens, entry.state.range.end, entry.value.range.start, "->");
  if (!arrow) {
    return;
  }
  edits.push({
    range: {
      start: removableHorizontalTriviaStart(arrow, entry.state.range.end),
      end: arrow.offset + arrow.length
    },
    newText: ":"
  });
}

function collectStateKeyEdits(
  tokens: readonly RsglToken[],
  state: StateKeySugarNode,
  symbols: MigrationSymbolResolution,
  edits: TextEdit[]
): void {
  const opening = findSourceToken(tokens, state.range.start, state.range.end, "[");
  const closing = findLastSourceToken(tokens, state.range.start, state.range.end, "]");
  const firstProperty = state.entries[0];
  const lastProperty = state.entries[state.entries.length - 1];
  if (opening) {
    edits.push({
      range: {
        start: opening.offset,
        end: firstProperty
          ? removableHorizontalTriviaEnd(tokens, opening.offset + opening.length, firstProperty.key.range.start)
          : opening.offset + opening.length
      },
      newText: firstProperty ? "{ " : "{"
    });
  }
  if (closing) {
    edits.push({
      range: {
        start: lastProperty
          ? removableHorizontalTriviaStart(closing, lastProperty.value.range.end)
          : closing.offset,
        end: closing.offset + closing.length
      },
      newText: lastProperty ? " }" : "}"
    });
  }

  for (const property of state.entries) {
    const equals = findSourceToken(tokens, property.key.range.end, property.value.range.start, "=");
    if (equals) {
      edits.push({
        range: {
          start: equals.offset,
          end: removableHorizontalTriviaEnd(tokens, equals.offset + equals.length, property.value.range.start)
        },
        newText: ": "
      });
    }
    if (property.key.kind === "Identifier"
      && symbols.resolvesValue(property.key.text, property.key.range.start)) {
      edits.push({ range: pointRange(property.key.range.start), newText: "[" });
      edits.push({ range: pointRange(property.key.range.end), newText: "]" });
    }
  }
}

function collectModelApplyEdits(
  tokens: readonly RsglToken[],
  apply: ModelApplySugarNode,
  edits: TextEdit[]
): TextRange | undefined {
  const marker = findSourceToken(tokens, apply.range.start, apply.model.range.start, "@");
  if (marker) {
    edits.push({ range: tokenRange(marker), newText: "" });
  }
  for (const property of apply.properties) {
    const equals = findSourceToken(tokens, property.name.range.end, property.range.end, "=");
    if (equals) {
      continue;
    }
    if (property.name.text === "uvlock"
      && property.value.kind === "BooleanLiteral"
      && property.value.value) {
      edits.push({ range: pointRange(property.name.range.end), newText: "=true" });
      continue;
    }
    return property.range;
  }
  return undefined;
}

function normalizeUnwrappedContent(content: string, desiredIndent: string): string {
  let normalized = trimOpeningBlankLine(content);
  normalized = trimClosingIndentLine(normalized);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/(\r?\n)/u);
  const lines = parts.filter((_part, index) => index % 2 === 0);
  const nonBlank = lines.filter(line => !isHorizontalWhitespace(line));
  if (nonBlank.length === 0) {
    return normalized;
  }
  const inlineFirstLine = parts.length > 1
    && !isHorizontalWhitespace(parts[0])
    && leadingWhitespaceLength(parts[0]) < desiredIndent.length;
  const ordinaryLines = inlineFirstLine ? nonBlank.filter(line => line !== parts[0]) : nonBlank;
  const minimumIndent = Math.min(...(ordinaryLines.length > 0 ? ordinaryLines : nonBlank).map(leadingWhitespaceLength));
  for (let index = 0; index < parts.length; index += 2) {
    if (isHorizontalWhitespace(parts[index])) {
      continue;
    }
    if (inlineFirstLine && index === 0) {
      parts[index] = desiredIndent + parts[index].slice(leadingWhitespaceLength(parts[index]));
      continue;
    }
    const adjustment = minimumIndent - desiredIndent.length;
    parts[index] = adjustment > 0
      ? parts[index].slice(Math.min(adjustment, leadingWhitespaceLength(parts[index])))
      : desiredIndent.slice(0, -adjustment) + parts[index];
  }
  return parts.join("");
}

function trimOpeningBlankLine(content: string): string {
  const newline = firstNewlineEnd(content);
  if (newline === 0) {
    return content;
  }
  return isHorizontalWhitespace(content.slice(0, newline.contentEnd))
    ? content.slice(newline.end)
    : content;
}

function trimClosingIndentLine(content: string): string {
  const start = lastNewlineStart(content);
  if (start < 0 || !isHorizontalWhitespace(content.slice(newlineEnd(content, start)))) {
    return content;
  }
  return content.slice(0, start);
}

export function findSourceToken(
  tokens: readonly RsglToken[],
  start: number,
  end: number,
  text: string
): RsglToken | undefined {
  return tokens.find(token =>
    start <= token.offset && token.offset + token.length <= end && token.text === text
  );
}

function findLastSourceToken(
  tokens: readonly RsglToken[],
  start: number,
  end: number,
  text: string
): RsglToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (start <= token.offset && token.offset + token.length <= end && token.text === text) {
      return token;
    }
  }
  return undefined;
}

function tokenRange(token: RsglToken): TextRange {
  return { start: token.offset, end: token.offset + token.length };
}

export function tokenEndRange(token: RsglToken): TextRange {
  return pointRange(token.offset + token.length);
}

function pointRange(offset: number): TextRange {
  return { start: offset, end: offset };
}

export function containsRange(container: TextRange, child: TextRange): boolean {
  return container.start <= child.start && child.end <= container.end;
}

function removableHorizontalTriviaStart(token: RsglToken, minimum: number): number {
  const relevant = token.leadingTrivia.filter(trivia => trivia.offset >= minimum);
  return relevant.length > 0
    && relevant[0].offset === minimum
    && relevant.every(trivia => trivia.kind === "whitespace")
    && relevant[relevant.length - 1].offset + relevant[relevant.length - 1].length === token.offset
    ? minimum
    : token.offset;
}

function removableHorizontalTriviaEnd(
  tokens: readonly RsglToken[],
  minimum: number,
  nextTokenOffset: number
): number {
  if (minimum === nextTokenOffset) {
    return minimum;
  }
  const next = tokens.find(token => token.offset === nextTokenOffset);
  if (!next) {
    return minimum;
  }
  const relevant = next.leadingTrivia.filter(trivia => trivia.offset >= minimum);
  return relevant.length > 0
    && relevant[0].offset === minimum
    && relevant.every(trivia => trivia.kind === "whitespace")
    && relevant[relevant.length - 1].offset + relevant[relevant.length - 1].length === nextTokenOffset
    ? nextTokenOffset
    : minimum;
}

function sourceLineStart(sourceText: string, offset: number): number {
  const lineFeed = sourceText.lastIndexOf("\n", Math.max(0, offset - 1));
  return lineFeed < 0 ? 0 : lineFeed + 1;
}

function isHorizontalWhitespace(value: string): boolean {
  for (const character of value) {
    if (character !== " " && character !== "\t") {
      return false;
    }
  }
  return true;
}

function leadingWhitespaceLength(value: string): number {
  let length = 0;
  while (length < value.length && (value[length] === " " || value[length] === "\t")) {
    length++;
  }
  return length;
}

function firstNewlineEnd(value: string): { contentEnd: number; end: number } | 0 {
  const lineFeed = value.indexOf("\n");
  if (lineFeed < 0) {
    return 0;
  }
  return {
    contentEnd: lineFeed > 0 && value[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed,
    end: lineFeed + 1
  };
}

function lastNewlineStart(value: string): number {
  const lineFeed = value.lastIndexOf("\n");
  if (lineFeed < 0) {
    return -1;
  }
  return lineFeed > 0 && value[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
}

function newlineEnd(value: string, start: number): number {
  return value[start] === "\r" && value[start + 1] === "\n" ? start + 2 : start + 1;
}
