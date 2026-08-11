import { lexRsgl, type RsglToken, type TextRange } from "./parser";
import type { RsglCompletionItem } from "./completionService";

export interface RsglCompletionEditRanges {
  insert: TextRange;
  replace: TextRange;
}

/**
 * Adds explicit insert/replace ranges and rejects cursor positions where syntax
 * completions would corrupt comments or string/template contents.
 */
export function withRsglCompletionEdits(
  items: readonly RsglCompletionItem[],
  text: string,
  offset: number,
  tokens: readonly RsglToken[] = lexRsgl(text).tokens
): RsglCompletionItem[] {
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  const base = baseCompletionRanges(text, clampedOffset, tokens);
  if (!base) {
    return [];
  }

  return items.map(item => {
    const newText = item.insertText ?? item.label;
    const start = extendedCompletionStart(text, clampedOffset, base.insert.start, item, newText);
    const replaceEnd = extendedCompletionEnd(text, start, base.replace.end, item, newText);
    return {
      ...item,
      edit: {
        insert: { start, end: clampedOffset },
        replace: { start, end: replaceEnd },
        newText
      }
    };
  });
}

function baseCompletionRanges(
  text: string,
  offset: number,
  tokens: readonly RsglToken[]
): RsglCompletionEditRanges | null {
  for (const token of tokens) {
    for (const trivia of token.leadingTrivia) {
      if (
        (trivia.kind === "lineComment" || trivia.kind === "blockComment")
        && trivia.offset < offset
        && offset <= trivia.offset + trivia.length
      ) {
        return null;
      }
    }
    if (
      (token.kind === "string" || token.kind === "templateString")
      && cursorIsInsideStringToken(text, token, offset)
    ) {
      return null;
    }
  }

  const resourceToken = tokens.find(token =>
    token.kind === "resourceLocation" && token.offset <= offset && offset <= token.offset + token.length
  );
  if (resourceToken) {
    return rangesForToken(resourceToken, offset);
  }

  const token = tokens.find(candidate =>
    isCompletableToken(candidate)
    && candidate.offset < offset
    && offset <= candidate.offset + candidate.length
  ) ?? tokens.find(candidate =>
    isCompletableToken(candidate)
    && candidate.offset === offset
  );
  if (token) {
    return rangesForToken(token, offset);
  }

  const minecraftPrefix = incompleteMinecraftResourcePrefix(text, offset);
  if (minecraftPrefix) {
    return {
      insert: { start: minecraftPrefix.start, end: offset },
      replace: { start: minecraftPrefix.start, end: minecraftPrefix.end }
    };
  }

  return {
    insert: { start: offset, end: offset },
    replace: { start: offset, end: offset }
  };
}

function rangesForToken(token: RsglToken, offset: number): RsglCompletionEditRanges {
  return {
    insert: { start: token.offset, end: offset },
    replace: { start: token.offset, end: token.offset + token.length }
  };
}

function isCompletableToken(token: RsglToken): boolean {
  return token.kind === "identifier" || token.kind === "keyword" || token.kind === "resourceLocation";
}

function cursorIsInsideStringToken(text: string, token: RsglToken, offset: number): boolean {
  if (offset <= token.offset) {
    return false;
  }
  const end = token.offset + token.length;
  if (offset < end) {
    return true;
  }
  if (offset > end) {
    return false;
  }
  const delimiter = token.kind === "string" ? "\"" : "`";
  return text[end - 1] !== delimiter;
}

function incompleteMinecraftResourcePrefix(
  text: string,
  offset: number
): { start: number; end: number } | null {
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  const match = /minecraft:[a-z0-9_./-]*$/.exec(text.slice(lineStart, offset));
  if (!match) {
    return null;
  }
  let end = offset;
  while (end < text.length && /[a-z0-9_./-]/.test(text[end])) {
    end++;
  }
  return { start: lineStart + (match.index ?? 0), end };
}

function extendedCompletionStart(
  text: string,
  offset: number,
  baseStart: number,
  item: RsglCompletionItem,
  newText: string
): number {
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  const matchTexts = item.insertText ? [newText, item.label] : [item.label];
  for (let start = lineStart; start <= baseStart; start++) {
    if (start > lineStart && !/[\s=>(,[{;]/.test(text[start - 1] ?? "")) {
      continue;
    }
    const typed = text.slice(start, offset);
    if (typed.length > 0 && matchTexts.some(candidate => candidate.startsWith(typed))) {
      return start;
    }
  }
  return baseStart;
}

function extendedCompletionEnd(
  text: string,
  start: number,
  baseEnd: number,
  item: RsglCompletionItem,
  newText: string
): number {
  const lineBreak = text.indexOf("\n", baseEnd);
  const carriageReturn = text.indexOf("\r", baseEnd);
  const lineEndCandidates = [lineBreak, carriageReturn].filter(index => index >= 0);
  const lineEnd = lineEndCandidates.length > 0 ? Math.min(...lineEndCandidates) : text.length;
  const matchTexts = item.insertText ? [newText, item.label] : [item.label];
  let replaceEnd = baseEnd;

  for (const candidate of matchTexts) {
    if (!candidate.startsWith(text.slice(start, baseEnd))) {
      continue;
    }
    let candidateEnd = baseEnd;
    while (
      candidateEnd < lineEnd
      && candidate.startsWith(text.slice(start, candidateEnd + 1))
    ) {
      candidateEnd++;
    }
    replaceEnd = Math.max(replaceEnd, candidateEnd);
  }
  return replaceEnd;
}
