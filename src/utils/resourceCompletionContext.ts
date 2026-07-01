import { parseJsonAst } from "./jsonAst";
import { isInArea } from "./locationChecker";
import {
  getResourceReferenceDocumentKind,
  getResourceReferencesForAst,
  ResourceReference,
  ResourceReferenceDocument
} from "./resourceReferences";

export interface ResourceCompletionTextPosition {
  line: number;
  character: number;
}

export interface ResourceCompletionTextRange {
  start: ResourceCompletionTextPosition;
  end: ResourceCompletionTextPosition;
}

export interface InferredResourceCompletionContext {
  reference: ResourceReference;
  replacementRange: ResourceCompletionTextRange;
  includeQuotes: boolean;
}

interface CompletionPatch {
  text: string;
  probeOffset: number;
  replacementRange: ResourceCompletionTextRange;
  includeQuotes: boolean;
}

export function inferIncompleteResourceCompletionContext(
  document: ResourceReferenceDocument,
  position: ResourceCompletionTextPosition
): InferredResourceCompletionContext | null {
  if (document.languageId !== "json") {
    return null;
  }

  const documentKind = getResourceReferenceDocumentKind(document.fileName);
  if (!documentKind) {
    return null;
  }

  const text = document.getText();
  const offset = offsetAt(text, position);
  if (offset === null) {
    return null;
  }

  const patch =
    createUnclosedStringPatch(text, position, offset) ??
    createMissingValuePatch(text, position, offset);
  if (!patch) {
    return null;
  }

  const ast = parseJsonAst(patch.text);
  if (!ast) {
    return null;
  }

  const probePosition = positionAt(patch.text, patch.probeOffset);
  const reference = getResourceReferencesForAst(ast, documentKind).find(item =>
    isInArea(probePosition.line + 1, probePosition.character + 1, item.valueNode.valueLoc ?? item.valueNode.loc)
  );

  return reference ? {
    reference,
    replacementRange: patch.replacementRange,
    includeQuotes: patch.includeQuotes
  } : null;
}

function createUnclosedStringPatch(
  text: string,
  position: ResourceCompletionTextPosition,
  offset: number
): CompletionPatch | null {
  const stringStart = findOpenStringStart(text, offset);
  if (stringStart === null) {
    return null;
  }

  return {
    text: insertAt(text, offset, "\""),
    probeOffset: offset,
    replacementRange: {
      start: positionAt(text, stringStart + 1),
      end: position
    },
    includeQuotes: false
  };
}

function createMissingValuePatch(
  text: string,
  position: ResourceCompletionTextPosition,
  offset: number
): CompletionPatch | null {
  if (!isMissingValuePosition(text, offset)) {
    return null;
  }

  return {
    text: insertAt(text, offset, "\"\""),
    probeOffset: offset + 1,
    replacementRange: {
      start: position,
      end: position
    },
    includeQuotes: true
  };
}

function findOpenStringStart(text: string, offset: number): number | null {
  let inString = false;
  let stringStart = -1;
  let escaping = false;

  for (let index = 0; index < offset; index++) {
    const character = text[index];
    if (!inString) {
      if (character === "\"") {
        inString = true;
        stringStart = index;
      }
      continue;
    }

    if (escaping) {
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === "\"") {
      inString = false;
      stringStart = -1;
    } else if (character === "\r" || character === "\n") {
      inString = false;
      stringStart = -1;
    }
  }

  return inString ? stringStart : null;
}

function isMissingValuePosition(text: string, offset: number): boolean {
  const previousToken = previousNonWhitespace(text, offset - 1);
  if (previousToken === null || text[previousToken] !== ":") {
    return false;
  }

  const nextToken = nextNonWhitespace(text, offset);
  return nextToken === null || text[nextToken] === "," || text[nextToken] === "}" || text[nextToken] === "]";
}

function previousNonWhitespace(text: string, offset: number): number | null {
  for (let index = offset; index >= 0; index--) {
    if (!isWhitespace(text[index])) {
      return index;
    }
  }

  return null;
}

function nextNonWhitespace(text: string, offset: number): number | null {
  for (let index = offset; index < text.length; index++) {
    if (!isWhitespace(text[index])) {
      return index;
    }
  }

  return null;
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function insertAt(text: string, offset: number, value: string): string {
  return `${text.slice(0, offset)}${value}${text.slice(offset)}`;
}

function offsetAt(text: string, position: ResourceCompletionTextPosition): number | null {
  const lineStarts = getLineStarts(text);
  if (position.line < 0 || position.line >= lineStarts.length || position.character < 0) {
    return null;
  }

  const lineStart = lineStarts[position.line];
  const lineEnd = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] : text.length;
  const offset = lineStart + position.character;
  return offset <= lineEnd ? offset : null;
}

function positionAt(text: string, offset: number): ResourceCompletionTextPosition {
  const lineStarts = getLineStarts(text);
  const normalizedOffset = Math.max(0, Math.min(offset, text.length));
  let line = lineStarts.length - 1;

  for (let index = lineStarts.length - 1; index >= 0; index--) {
    if (lineStarts[index] <= normalizedOffset) {
      line = index;
      break;
    }
  }

  return {
    line,
    character: normalizedOffset - lineStarts[line]
  };
}

function getLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}
