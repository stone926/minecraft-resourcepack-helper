import type { AstLocation } from "./locationChecker";

export interface CitPropertyEntry {
  key: string;
  value: string;
  rawKey: string;
  rawValue: string;
  keyRange: AstLocation;
  valueRange: AstLocation;
  fullRange: AstLocation;
  line: number;
}

export interface CitPropertiesPosition {
  line: number;
  character: number;
}

export function parseCitProperties(text: string): CitPropertyEntry[] {
  const entries: CitPropertyEntry[] = [];
  const lines = text.split(/\r\n|\n|\r/);

  lines.forEach((line, index) => {
    const entry = parseCitPropertyLine(line, index + 1);
    if (entry) {
      entries.push(entry);
    }
  });

  return entries;
}

export function parseCitPropertyLine(line: string, lineNumber: number): CitPropertyEntry | null {
  const contentStart = firstNonWhitespaceIndex(line);
  if (contentStart === line.length || line[contentStart] === "#" || line[contentStart] === "!") {
    return null;
  }

  const separatorIndex = findPropertySeparator(line, contentStart);
  if (separatorIndex < 0) {
    return null;
  }

  const keyEnd = trimEndIndex(line, separatorIndex);
  const valueStart = firstNonWhitespaceIndex(line, separatorIndex + 1);
  const valueEnd = trimEndIndex(line, line.length);
  const rawKey = line.slice(contentStart, keyEnd);
  const rawValue = line.slice(valueStart, Math.max(valueStart, valueEnd));

  return {
    key: unescapeProperty(rawKey),
    value: unescapeProperty(rawValue),
    rawKey,
    rawValue,
    keyRange: createLocation(lineNumber, contentStart, keyEnd),
    valueRange: createLocation(lineNumber, valueStart, valueStart + rawValue.length),
    fullRange: createLocation(lineNumber, contentStart, valueStart + rawValue.length),
    line: lineNumber
  };
}

export function findCitPropertyEntryAtPosition(
  entries: CitPropertyEntry[],
  position: CitPropertiesPosition
): CitPropertyEntry | null {
  const line = position.line + 1;
  const character = position.character;

  return entries.find(entry =>
    entry.line === line &&
    character >= entry.fullRange.start.column &&
    character <= entry.fullRange.end.column
  ) ?? null;
}

export function isPositionInLocation(position: CitPropertiesPosition, location: AstLocation): boolean {
  const line = position.line + 1;
  const character = position.character;
  return line === location.start.line &&
    character >= location.start.column &&
    character <= location.end.column;
}

export function findPropertySeparator(line: string, start = 0): number {
  let escaping = false;
  for (let index = start; index < line.length; index++) {
    const character = line[index];
    if (escaping) {
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === "=" || character === ":") {
      return index;
    }
  }

  return -1;
}

export function firstNonWhitespaceIndex(value: string, start = 0): number {
  for (let index = start; index < value.length; index++) {
    if (!isWhitespace(value[index])) {
      return index;
    }
  }

  return value.length;
}

export function trimEndIndex(value: string, end: number): number {
  for (let index = end - 1; index >= 0; index--) {
    if (!isWhitespace(value[index])) {
      return index + 1;
    }
  }

  return 0;
}

function unescapeProperty(value: string): string {
  let result = "";
  let escaping = false;

  for (const character of value) {
    if (escaping) {
      result += unescapeCharacter(character);
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else {
      result += character;
    }
  }

  return escaping ? `${result}\\` : result;
}

function unescapeCharacter(character: string): string {
  if (character === "t") {
    return "\t";
  }
  if (character === "n") {
    return "\n";
  }
  if (character === "r") {
    return "\r";
  }
  if (character === "f") {
    return "\f";
  }
  return character;
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
