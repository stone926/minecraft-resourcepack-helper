import { lm, type LocalizedMessage } from "../i18n/messages";
import { LruCache } from "../services/lruCache";
import type { AstLocation } from "../utils/locationChecker";

export interface CitPropertyEntry {
  key: string;
  value: string;
  rawKey: string;
  rawValue: string;
  keyRange: AstLocation;
  valueRange: AstLocation;
  fullRange: AstLocation;
  line: number;
  hasSyntaxError?: boolean;
}

export interface CitPropertySyntaxError {
  message: LocalizedMessage;
  range: AstLocation;
  line: number;
}

export interface CitPropertiesParseResult {
  entries: CitPropertyEntry[];
  errors: CitPropertySyntaxError[];
  /** Physical source lines shared by parsing and cursor-sensitive language features. */
  physicalLines: string[];
}

export interface CitPropertiesDocument {
  fileName: string;
  version?: number;
  uri?: {
    toString(): string;
  };
  getText(): string;
}

export interface CitPropertiesPosition {
  line: number;
  character: number;
}

interface LogicalCharacterLocation {
  line: number;
  column: number;
}

interface LogicalCitPropertyLine {
  text: string;
  locations: LogicalCharacterLocation[];
  startLine: number;
  startColumn: number;
}

interface CachedCitPropertiesParseResult {
  version: number;
  result: CitPropertiesParseResult;
}

const maxCachedCitPropertiesDocuments = 128;
const citPropertiesDocumentCache = new LruCache<string, CachedCitPropertiesParseResult>(
  maxCachedCitPropertiesDocuments
);

export function parseCitProperties(text: string): CitPropertyEntry[] {
  return parseCitPropertiesDocument(text).entries;
}

export function parseCitPropertiesDocument(text: string): CitPropertiesParseResult {
  const entries: CitPropertyEntry[] = [];
  const errors: CitPropertySyntaxError[] = [];
  const physicalLines = text.split(/\r\n|\n|\r/);

  for (const logicalLine of getLogicalLines(physicalLines)) {
    const entry = parseLogicalCitPropertyLine(logicalLine, errors);
    if (entry) {
      entries.push(entry);
    }
  }

  return { entries, errors, physicalLines };
}

export function getCitPropertiesParseResult(document: CitPropertiesDocument, text?: string): CitPropertiesParseResult {
  if (typeof document.version !== "number") {
    return parseCitPropertiesDocument(text ?? document.getText());
  }

  const key = citPropertiesCacheKey(document);
  const cached = citPropertiesDocumentCache.get(key);
  if (cached && cached.version === document.version) {
    return cached.result;
  }

  const result = parseCitPropertiesDocument(text ?? document.getText());
  citPropertiesDocumentCache.set(key, { version: document.version, result });
  return result;
}

export function getCitPropertiesEntries(document: CitPropertiesDocument): CitPropertyEntry[] {
  return getCitPropertiesParseResult(document).entries;
}

export function parseCitPropertyLine(line: string, lineNumber: number): CitPropertyEntry | null {
  return parseLogicalCitPropertyLine(createSingleLogicalLine(line, lineNumber), []);
}

export function findCitPropertyEntryAtPosition(
  entries: CitPropertyEntry[],
  position: CitPropertiesPosition
): CitPropertyEntry | null {
  return entries.find(entry => isPositionInLocation(position, entry.fullRange)) ?? null;
}

export function isPositionInLocation(position: CitPropertiesPosition, location: AstLocation): boolean {
  const line = position.line + 1;
  const character = position.character;
  if (line < location.start.line || line > location.end.line) {
    return false;
  }
  if (line === location.start.line && character < location.start.column) {
    return false;
  }
  if (line === location.end.line && character > location.end.column) {
    return false;
  }
  return true;
}

export function findPropertySeparator(line: string, start = 0): number {
  const equalsIndex = findUnescapedSeparator(line, "=", start);
  if (equalsIndex >= 0) {
    return equalsIndex;
  }

  return findUnescapedSeparator(line, ":", start);
}

function findUnescapedSeparator(line: string, separator: "=" | ":", start: number): number {
  let escaping = false;
  for (let index = start; index < line.length; index++) {
    const character = line[index];
    if (escaping) {
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === separator) {
      return index;
    }
  }

  return -1;
}

function citPropertiesCacheKey(document: CitPropertiesDocument): string {
  return document.uri?.toString() ?? document.fileName;
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

function parseLogicalCitPropertyLine(
  logicalLine: LogicalCitPropertyLine,
  errors: CitPropertySyntaxError[]
): CitPropertyEntry | null {
  const line = logicalLine.text;
  const contentStart = firstNonWhitespaceIndex(line);
  if (contentStart === line.length || line[contentStart] === "#" || line[contentStart] === "!") {
    return null;
  }

  const separatorIndex = findPropertySeparator(line, contentStart);
  if (separatorIndex < 0) {
    errors.push({
      message: lm("Missing CIT property separator '=' or ':'."),
      range: createLogicalLocation(logicalLine, contentStart, line.length),
      line: locationAtLogicalOffset(logicalLine, contentStart).line
    });
    return null;
  }

  const keyEnd = trimEndIndex(line, separatorIndex);
  const valueStart = firstNonWhitespaceIndex(line, separatorIndex + 1);
  const valueEnd = trimEndIndex(line, line.length);
  const rawKey = line.slice(contentStart, keyEnd);
  const rawValue = line.slice(valueStart, Math.max(valueStart, valueEnd));
  const keyRange = createLogicalLocation(logicalLine, contentStart, keyEnd);
  const keyErrorStart = errors.length;
  const key = unescapeProperty(rawKey, logicalLine, contentStart, errors);
  validatePropertyKey(key, keyRange, errors);
  const hasSyntaxError = errors.length > keyErrorStart;

  return {
    key,
    value: unescapeProperty(rawValue, logicalLine, valueStart, errors),
    rawKey,
    rawValue,
    keyRange,
    valueRange: createLogicalLocation(logicalLine, valueStart, valueStart + rawValue.length),
    fullRange: createLogicalLocation(logicalLine, contentStart, valueStart + rawValue.length),
    line: locationAtLogicalOffset(logicalLine, contentStart).line,
    ...(hasSyntaxError ? { hasSyntaxError } : {})
  };
}

function validatePropertyKey(
  key: string,
  range: AstLocation,
  errors: CitPropertySyntaxError[]
): void {
  if (key.length === 0) {
    errors.push({
      message: lm("CIT property key cannot be empty."),
      range,
      line: range.start.line
    });
    return;
  }

  if (/\s/.test(key)) {
    errors.push({
      message: lm("CIT property key cannot contain whitespace."),
      range,
      line: range.start.line
    });
  }
}

function getLogicalLines(lines: readonly string[]): LogicalCitPropertyLine[] {
  const logicalLines: LogicalCitPropertyLine[] = [];
  let current: LogicalCitPropertyLine | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const physicalLine = index + 1;
    const startColumn: number = current ? firstNonWhitespaceIndex(line) : 0;
    if (!current && isIgnorablePhysicalLine(line)) {
      logicalLines.push(createSingleLogicalLine(line, physicalLine));
      continue;
    }
    if (current && isCommentLine(line, startColumn)) {
      continue;
    }

    const continued = hasLineContinuation(line);
    const endColumn = continued ? line.length - 1 : line.length;
    const segment = line.slice(startColumn, Math.max(startColumn, endColumn));

    if (!current) {
      current = {
        text: "",
        locations: [],
        startLine: physicalLine,
        startColumn
      };
    } else {
      appendLogicalSegment(current, "\\n", physicalLine, startColumn);
    }

    appendLogicalSegment(current, segment, physicalLine, startColumn);

    if (!continued) {
      logicalLines.push(current);
      current = null;
    }
  }

  if (current) {
    const last = current.locations[current.locations.length - 1] ?? {
      line: current.startLine,
      column: current.startColumn
    };
    appendLogicalSegment(current, "\\n", last.line, last.column + 1);
    logicalLines.push(current);
  }

  return logicalLines;
}

function appendLogicalSegment(
  logicalLine: LogicalCitPropertyLine,
  segment: string,
  physicalLine: number,
  startColumn: number
): void {
  logicalLine.text += segment;
  for (let index = 0; index < segment.length; index++) {
    logicalLine.locations.push({ line: physicalLine, column: startColumn + index });
  }
}

function hasLineContinuation(line: string): boolean {
  let backslashes = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function isCommentLine(line: string, startColumn: number): boolean {
  return line[startColumn] === "#" || line[startColumn] === "!";
}

function isIgnorablePhysicalLine(line: string): boolean {
  const contentStart = firstNonWhitespaceIndex(line);
  return contentStart === line.length || isCommentLine(line, contentStart);
}

function createSingleLogicalLine(line: string, lineNumber: number): LogicalCitPropertyLine {
  const logicalLine: LogicalCitPropertyLine = {
    text: line,
    locations: [],
    startLine: lineNumber,
    startColumn: 0
  };
  appendLogicalSegment(logicalLine, line, lineNumber, 0);
  return logicalLine;
}

function unescapeProperty(
  value: string,
  logicalLine: LogicalCitPropertyLine,
  baseOffset: number,
  errors: CitPropertySyntaxError[]
): string {
  let result = "";

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      result += "\\";
      continue;
    }

    if (escaped === "u") {
      const unicode = value.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(unicode)) {
        result += String.fromCharCode(Number.parseInt(unicode, 16));
        index += 5;
        continue;
      }

      errors.push({
        message: lm("Invalid unicode escape in CIT property; expected \\uXXXX."),
        range: createLogicalLocation(
          logicalLine,
          baseOffset + index,
          Math.min(baseOffset + index + 6, baseOffset + value.length)
        ),
        line: locationAtLogicalOffset(logicalLine, baseOffset + index).line
      });
      result += "u";
      index++;
      continue;
    }

    result += unescapeCharacter(escaped);
    index++;
  }

  return result;
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

function createLogicalLocation(logicalLine: LogicalCitPropertyLine, startOffset: number, endOffset: number): AstLocation {
  return {
    start: locationAtLogicalOffset(logicalLine, startOffset),
    end: locationAtLogicalOffset(logicalLine, endOffset)
  };
}

function locationAtLogicalOffset(logicalLine: LogicalCitPropertyLine, offset: number): LogicalCharacterLocation {
  if (logicalLine.locations.length === 0) {
    return { line: logicalLine.startLine, column: logicalLine.startColumn };
  }

  const boundedOffset = Math.max(0, Math.min(offset, logicalLine.locations.length));
  if (boundedOffset < logicalLine.locations.length) {
    return logicalLine.locations[boundedOffset];
  }

  const last = logicalLine.locations[logicalLine.locations.length - 1];
  return { line: last.line, column: last.column + 1 };
}
