import type { RsglToken, Trivia } from "../parser";

export type RsglFragmentPosition = "whole" | "start" | "middle" | "end";

export interface RsglFormatTokenFragment {
  kind: "token";
  token: RsglToken;
  text: string;
  position: RsglFragmentPosition;
}

export interface RsglFormatCommentFragment {
  kind: "comment";
  commentKind: "lineComment" | "blockComment";
  text: string;
  position: RsglFragmentPosition;
}

export type RsglFormatItem = RsglFormatTokenFragment | RsglFormatCommentFragment;

export interface RsglFormatLine {
  items: RsglFormatItem[];
  separator?: string;
  separatorProtected: boolean;
  preserveLeadingText: boolean;
  originalTrailingWhitespace: string;
}

export interface RsglFormatDocument {
  lines: RsglFormatLine[];
  preferredEol: string;
}

export function buildRsglFormatDocument(
  tokens: readonly RsglToken[]
): RsglFormatDocument {
  const lines: RsglFormatLine[] = [];
  let current = createLine();
  let pendingWhitespace = "";
  const layoutEolCounts = new Map<string, number>();
  const allEolCounts = new Map<string, number>();

  const finishLine = (separator: string, separatorProtected: boolean): void => {
    current.originalTrailingWhitespace = pendingWhitespace;
    pendingWhitespace = "";
    current.separator = separator;
    current.separatorProtected = separatorProtected;
    lines.push(current);
    allEolCounts.set(separator, (allEolCounts.get(separator) ?? 0) + 1);
    if (!separatorProtected && current.items.length > 0) {
      layoutEolCounts.set(
        separator,
        (layoutEolCounts.get(separator) ?? 0) + 1
      );
    }
    current = createLine();
  };

  const appendFragment = (
    item: RsglFormatItem,
    continuation: boolean
  ): void => {
    if (continuation && current.items.length === 0) {
      current.preserveLeadingText = true;
    }
    current.items.push(item);
  };

  const appendMultiline = (
    text: string,
    createItem: (part: string, position: RsglFragmentPosition) => RsglFormatItem,
    separatorProtected: boolean,
    preserveContinuationLeading: boolean
  ): void => {
    const segments = splitWithNewlines(text);
    const partCount = segments.filter(segment => !segment.newline).length;
    let partIndex = 0;
    for (const segment of segments) {
      if (segment.newline) {
        finishLine(segment.text, separatorProtected);
        continue;
      }
      const position = fragmentPosition(partIndex, partCount);
      appendFragment(
        createItem(segment.text, position),
        preserveContinuationLeading && partIndex > 0
      );
      partIndex++;
    }
  };

  const appendTrivia = (trivia: Trivia): void => {
    switch (trivia.kind) {
      case "whitespace":
        pendingWhitespace += trivia.text;
        return;
      case "newline":
        finishLine(trivia.text, false);
        return;
      case "lineComment":
        pendingWhitespace = "";
        appendFragment({
          kind: "comment",
          commentKind: "lineComment",
          text: trivia.text,
          position: "whole"
        }, false);
        return;
      case "blockComment": {
        const originalIndent = pendingWhitespace;
        const startsAfterContent = current.items.length > 0;
        pendingWhitespace = "";
        appendMultiline(
          startsAfterContent
            ? trivia.text
            : stripBlockCommentLineIndent(trivia.text, originalIndent),
          (part, position) => ({
            kind: "comment",
            commentKind: "blockComment",
            text: part,
            position
          }),
          true,
          startsAfterContent
        );
        return;
      }
    }
  };

  for (const token of tokens) {
    token.leadingTrivia.forEach(appendTrivia);
    if (token.kind === "endOfFile") {
      continue;
    }
    pendingWhitespace = "";
    const verbatim = token.kind === "templateString" || token.kind === "string";
    appendMultiline(
      token.text,
      (part, position) => ({
        kind: "token",
        token,
        text: part,
        position
      }),
      verbatim,
      verbatim
    );
  }

  current.originalTrailingWhitespace = pendingWhitespace;
  lines.push(current);
  const preferredEol = mostFrequentEol(
    layoutEolCounts.size > 0 ? layoutEolCounts : allEolCounts
  );
  for (const line of lines) {
    if (line.separator !== undefined && !line.separatorProtected) {
      line.separator = preferredEol;
    }
  }
  return {
    lines,
    preferredEol
  };
}

export function createRsglFormatLine(
  items: RsglFormatItem[] = [],
  separator?: string
): RsglFormatLine {
  return {
    items,
    separator,
    separatorProtected: false,
    preserveLeadingText: false,
    originalTrailingWhitespace: ""
  };
}

export function isRsglFormatLineBlank(line: RsglFormatLine): boolean {
  return line.items.length === 0;
}

export function wholeTokenItems(line: RsglFormatLine): RsglFormatTokenFragment[] {
  return line.items.filter((item): item is RsglFormatTokenFragment =>
    item.kind === "token" && item.position === "whole"
  );
}

function createLine(): RsglFormatLine {
  return createRsglFormatLine();
}

function fragmentPosition(index: number, count: number): RsglFragmentPosition {
  if (count <= 1) {
    return "whole";
  }
  if (index === 0) {
    return "start";
  }
  return index === count - 1 ? "end" : "middle";
}

function splitWithNewlines(text: string): Array<{ text: string; newline: boolean }> {
  const result: Array<{ text: string; newline: boolean }> = [];
  const expression = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    result.push({ text: text.slice(start, match.index), newline: false });
    result.push({ text: match[0], newline: true });
    start = match.index + match[0].length;
  }
  result.push({ text: text.slice(start), newline: false });
  return result;
}

function mostFrequentEol(counts: ReadonlyMap<string, number>): string {
  let selected = "\n";
  let selectedCount = 0;
  for (const [eol, count] of counts) {
    if (count > selectedCount) {
      selected = eol;
      selectedCount = count;
    }
  }
  return selected;
}

function stripBlockCommentLineIndent(text: string, originalIndent: string): string {
  if (originalIndent.length === 0 || !/^[ \t]+$/.test(originalIndent)) {
    return text;
  }
  return text.replace(/(\r\n|\r|\n)([ \t]*)/g, (_match, newline: string, indent: string) =>
    `${newline}${indent.startsWith(originalIndent) ? indent.slice(originalIndent.length) : indent}`
  );
}
