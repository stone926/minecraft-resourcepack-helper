import { getCitDocumentSource, getCitResourceType } from "./citPaths";
import type { AstLocation } from "./locationChecker";
import type { ResourceReference } from "./resourceReferences";

export function getCitPropertyReferences(text: string, fileName: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  const source = getCitDocumentSource(fileName);

  lines.forEach((line, index) => {
    const reference = getCitPropertyReference(line, index + 1, source);
    if (reference) {
      references.push(reference);
    }
  });

  return references;
}

function getCitPropertyReference(line: string, lineNumber: number, source: string): ResourceReference | null {
  const contentStart = firstNonWhitespaceIndex(line);
  if (contentStart === line.length || line[contentStart] === "#") {
    return null;
  }

  const separatorIndex = findPropertySeparator(line, contentStart);
  if (separatorIndex < 0) {
    return null;
  }

  const keyEnd = trimEndIndex(line, separatorIndex);
  const key = line.slice(contentStart, keyEnd);
  const resourceType = getCitResourceType(key);
  if (!resourceType) {
    return null;
  }

  const valueStart = firstNonWhitespaceIndex(line, separatorIndex + 1);
  const valueEnd = trimEndIndex(line, line.length);
  const value = line.slice(valueStart, Math.max(valueStart, valueEnd));
  const valueLoc = createLocation(lineNumber, valueStart, valueStart + value.length);

  return {
    value,
    valueNode: {
      loc: createLocation(lineNumber, contentStart, valueStart + value.length),
      valueLoc,
      hitLoc: createLocation(lineNumber, valueStart + 1, Math.max(valueStart + value.length + 1, valueStart + 1))
    },
    target: resourceType,
    source,
    extension: resourceType === "textures" ? "png" : "json",
    kind: resourceType === "textures" ? "texture" : "model",
    resolveMode: "cit"
  };
}

function findPropertySeparator(line: string, start: number): number {
  let escaping = false;
  for (let index = start; index < line.length; index++) {
    const character = line[index];
    if (escaping) {
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === "=") {
      return index;
    }
  }

  return -1;
}

function firstNonWhitespaceIndex(value: string, start = 0): number {
  for (let index = start; index < value.length; index++) {
    if (!isWhitespace(value[index])) {
      return index;
    }
  }

  return value.length;
}

function trimEndIndex(value: string, end: number): number {
  for (let index = end - 1; index >= 0; index--) {
    if (!isWhitespace(value[index])) {
      return index + 1;
    }
  }

  return 0;
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\f";
}

function createLocation(line: number, startColumn: number, endColumn: number): AstLocation {
  return {
    start: { line, column: startColumn },
    end: { line, column: endColumn }
  };
}
