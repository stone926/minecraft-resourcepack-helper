/**
 * Two location dialects coexist in this codebase and their column bases differ:
 * - jsonAst (momoa) positions are 1-based line AND 1-based column;
 * - the CIT properties parser emits 1-based line but 0-based column.
 *
 * This module is deliberately VS Code-free: it converts between source dialects
 * and plain 0-based `{ line, character }` pairs. Callers construct their own
 * `vscode.Range`/diagnostic/editor types from the pair, so vscode-free unit
 * tests can import it without a VS Code mock.
 */

export interface JsonAstLineColumn {
  line: number;
  column: number;
}

export interface JsonAstLocationLike {
  start: JsonAstLineColumn;
  end: JsonAstLineColumn;
}

export interface CitLineColumn {
  line: number;
  column: number;
}

export interface CitLocationLike {
  start: CitLineColumn;
  end: CitLineColumn;
}

export interface LineCharacterPair {
  line: number;
  character: number;
}

export interface LineCharacterRange {
  start: LineCharacterPair;
  end: LineCharacterPair;
}

/** momoa `loc` (1-based line + column) to a 0-based `{ line, character }` pair range. */
export function jsonAstLocationToLineCharacterRange(location: JsonAstLocationLike): LineCharacterRange {
  return {
    start: { line: location.start.line - 1, character: location.start.column - 1 },
    end: { line: location.end.line - 1, character: location.end.column - 1 }
  };
}

/** CIT parser location (1-based line, 0-based column) to a 0-based pair range. */
export function citLocationToLineCharacterRange(location: CitLocationLike): LineCharacterRange {
  return {
    start: { line: location.start.line - 1, character: location.start.column },
    end: { line: location.end.line - 1, character: location.end.column }
  };
}

/** Tests a 0-based position against a momoa `loc` (1-based line + column). */
export function isPositionInJsonAstLocation(
  position: LineCharacterPair,
  location: JsonAstLocationLike
): boolean {
  return isInBasisRange(position, location, 1);
}

/** Tests a 0-based position against a CIT parser location (0-based column). */
export function isPositionInCitLocation(
  position: LineCharacterPair,
  location: CitLocationLike
): boolean {
  return isInBasisRange(position, location, 0);
}

/** Copies an already-normalized 0-based `{ line, character }` range. */
export function copyLineCharacterRange(range: LineCharacterRange): LineCharacterRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function isInBasisRange(
  position: LineCharacterPair,
  location: { start: { line: number; column: number }; end: { line: number; column: number } },
  columnBasis: 0 | 1
): boolean {
  const inputLine = position.line + 1;
  const inputColumn = position.character + columnBasis;
  const startLine = location.start.line;
  const endLine = location.end.line;
  const startColumn = location.start.column;
  const endColumn = location.end.column;
  return (startLine < inputLine && inputLine < endLine) ||
    (startLine === inputLine && startLine !== endLine && startColumn <= inputColumn) ||
    (endLine === inputLine && startLine !== endLine && endColumn >= inputColumn) ||
    (startLine === endLine && endLine === inputLine && startColumn <= inputColumn && inputColumn <= endColumn);
}
