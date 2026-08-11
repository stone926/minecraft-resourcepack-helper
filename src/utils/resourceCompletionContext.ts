import { parseJsonAst } from "./jsonAst";
import { isInArea } from "./locationChecker";
import { TextOffsetMap } from "./textOffsets";
import { decodeJsonStringContent } from "./resourceCompletionEdits";
import { getResourceReferenceExtraction } from "../resources/resourceSurfaceRegistry";
import {
  getReferencesForDocumentKind,
  getResourceReferenceDocumentKind,
  ResourceReference,
  ResourceReferenceDocument
} from "./resourceReferences";
import { getShaderSourceDirectory } from "./resourceReferences/shaderRefs";

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
  insertingRange: ResourceCompletionTextRange;
  replacingRange: ResourceCompletionTextRange;
  insertPrefix: string;
  insertSuffix: string;
}

interface CompletionPatch {
  text: string;
  probeOffset: number;
  insertingRange: ResourceCompletionTextRange;
  replacingRange: ResourceCompletionTextRange;
  insertPrefix: string;
  insertSuffix: string;
  completionValue?: string;
}

export function inferIncompleteResourceCompletionContext(
  document: ResourceReferenceDocument,
  position: ResourceCompletionTextPosition
): InferredResourceCompletionContext | null {
  const documentKind = getResourceReferenceDocumentKind(document.fileName);
  if (!documentKind) {
    return null;
  }

  if (document.languageId !== "json") {
    return inferIncompleteShaderCompletionContext(document, position, documentKind);
  }

  const text = document.getText();
  const textOffsets = new TextOffsetMap(text);
  const offset = textOffsets.offsetAt(position);
  if (offset === null) {
    return null;
  }

  const patch =
    createStringPatch(text, textOffsets, position, offset) ??
    createMissingValuePatch(text, position, offset);
  if (!patch) {
    return null;
  }

  const repaired = repairMissingJsonValues(patch.text, patch.probeOffset);
  const ast = parseJsonAst(repaired.text, { allowTrailingCommas: true });
  if (!ast) {
    return null;
  }

  const probePosition = new TextOffsetMap(repaired.text).positionAt(repaired.probeOffset);
  const reference = getReferencesForDocumentKind(ast, documentKind, document.fileName).find(item =>
    isInArea(probePosition.line + 1, probePosition.character + 1, item.valueNode.valueLoc ?? item.valueNode.loc)
  );

  return reference ? {
    reference: patch.completionValue === undefined
      ? reference
      : { ...reference, value: patch.completionValue },
    insertingRange: patch.insertingRange,
    replacingRange: patch.replacingRange,
    insertPrefix: patch.insertPrefix,
    insertSuffix: patch.insertSuffix
  } : null;
}

function createStringPatch(
  text: string,
  textOffsets: TextOffsetMap,
  position: ResourceCompletionTextPosition,
  offset: number
): CompletionPatch | null {
  const stringStart = findOpenStringStart(text, offset);
  if (stringStart === null) {
    return null;
  }

  const stringEnd = findStringEnd(text, stringStart);
  const contentStart = stringStart + 1;
  if (stringEnd !== null) {
    if (offset < contentStart || stringEnd < offset) {
      return null;
    }
    const completionValue = decodeJsonStringContent(text.slice(contentStart, offset));
    if (completionValue === null) {
      return null;
    }
    return {
      text,
      probeOffset: offset,
      insertingRange: {
        start: textOffsets.positionAt(contentStart),
        end: position
      },
      replacingRange: {
        start: textOffsets.positionAt(contentStart),
        end: textOffsets.positionAt(stringEnd)
      },
      insertPrefix: "",
      insertSuffix: "",
      completionValue
    };
  }

  return {
    text: insertAt(text, offset, "\""),
    probeOffset: offset,
    insertingRange: {
      start: textOffsets.positionAt(contentStart),
      end: position
    },
    replacingRange: {
      start: textOffsets.positionAt(contentStart),
      end: position
    },
    insertPrefix: "",
    insertSuffix: "\""
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
    insertingRange: {
      start: position,
      end: position
    },
    replacingRange: {
      start: position,
      end: position
    },
    insertPrefix: "\"",
    insertSuffix: "\""
  };
}

function inferIncompleteShaderCompletionContext(
  document: ResourceReferenceDocument,
  position: ResourceCompletionTextPosition,
  documentKind: NonNullable<ReturnType<typeof getResourceReferenceDocumentKind>>
): InferredResourceCompletionContext | null {
  const extraction = getResourceReferenceExtraction(documentKind);
  if (extraction?.mode !== "shader") {
    return null;
  }

  const text = document.getText();
  const textOffsets = new TextOffsetMap(text);
  const offset = textOffsets.offsetAt(position);
  if (offset === null) {
    return null;
  }
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  const linePrefix = text.slice(lineStart, offset);
  const match = /#\s*moj_import\s*(<|")([^>"\r\n]*)$/.exec(linePrefix);
  if (!match) {
    return null;
  }

  const opening = match[1];
  const value = match[2];
  const valueStart = lineStart + (match.index ?? 0) + match[0].length - value.length;
  const source = getShaderSourceDirectory(document.fileName, extraction.source);
  const relative = opening === "\"";
  const range = {
    start: textOffsets.positionAt(valueStart),
    end: position
  };
  return {
    reference: {
      value,
      valueNode: {},
      target: relative ? source : "shaders/include",
      source,
      extension: null,
      kind: "shader",
      ...(relative ? { resolveMode: "relative" as const } : {})
    },
    insertingRange: range,
    replacingRange: range,
    insertPrefix: "",
    insertSuffix: relative ? "\"" : ">"
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

function findStringEnd(text: string, stringStart: number): number | null {
  let escaping = false;
  for (let index = stringStart + 1; index < text.length; index++) {
    const character = text[index];
    if (escaping) {
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === "\"") {
      return index;
    } else if (character === "\r" || character === "\n") {
      return null;
    }
  }
  return null;
}

function repairMissingJsonValues(text: string, probeOffset: number): { text: string; probeOffset: number } {
  const insertions: number[] = [];
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (character === "\\") {
        escaping = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character !== ":") {
      continue;
    }
    const next = nextNonWhitespace(text, index + 1);
    if (next === null || text[next] === "," || text[next] === "}" || text[next] === "]") {
      insertions.push(index + 1);
    }
  }
  if (insertions.length === 0) {
    return { text, probeOffset };
  }

  let repaired = text;
  let adjustedProbe = probeOffset;
  for (let index = insertions.length - 1; index >= 0; index--) {
    const insertion = insertions[index];
    repaired = insertAt(repaired, insertion, "null");
    if (insertion <= adjustedProbe) {
      adjustedProbe += 4;
    }
  }
  return { text: repaired, probeOffset: adjustedProbe };
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
