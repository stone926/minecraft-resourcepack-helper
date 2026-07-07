import { AstLocation } from "../locationChecker";
import { ResourceReference, ResourceReferenceDocumentKind } from "./types";

export function getShaderReferences(text: string, source: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const lineStarts = getLineStarts(text);
  const importPattern = /#\s*moj_import\s*(?:<([^>\r\n]+)>|"([^"\r\n]+)")/g;

  for (const match of text.matchAll(importPattern)) {
    const value = match[1] ?? match[2];
    if (value === undefined || match.index === undefined) {
      continue;
    }

    const valueStart = match.index + match[0].indexOf(value);
    const valueEnd = valueStart + value.length;
    const valueLoc = getLocationForOffsets(lineStarts, valueStart, valueEnd);
    const target = match[1] !== undefined || value.includes(":") ? "shaders/include" : "shaders/core";
    references.push({
      value,
      valueNode: {
        loc: valueLoc,
        valueLoc
      },
      target,
      source,
      extension: null,
      kind: "shader"
    });
  }

  return references;
}

export function isShaderDocumentKind(kind: ResourceReferenceDocumentKind): boolean {
  return kind === "shaderCore" || kind === "shaderPost";
}

export function getShaderDocumentSource(kind: ResourceReferenceDocumentKind): string {
  if (kind === "shaderCore") {
    return "shaders/core";
  }

  return "shaders/post";
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

function getLocationForOffsets(lineStarts: number[], startOffset: number, endOffset: number): AstLocation {
  const startLine = findLineIndex(lineStarts, startOffset);
  const endLine = findLineIndex(lineStarts, endOffset);

  return {
    start: {
      line: startLine + 1,
      column: startOffset - lineStarts[startLine]
    },
    end: {
      line: endLine + 1,
      column: endOffset - lineStarts[endLine]
    }
  };
}

function findLineIndex(lineStarts: number[], offset: number): number {
  for (let index = lineStarts.length - 1; index >= 0; index--) {
    if (lineStarts[index] <= offset) {
      return index;
    }
  }

  return 0;
}
