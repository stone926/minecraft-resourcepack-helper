export interface AstLocation {
  start: { line: number, column: number };
  end: { line: number, column: number };
}

export function isInArea(inputLine: number, inputColumn: number, astLoc: AstLocation | null | undefined): boolean {
  if (!astLoc) {
    return false;
  }
  const startLine: number = astLoc.start.line;
  const endLine: number = astLoc.end.line;
  const startColumn: number = astLoc.start.column;
  const endColumn: number = astLoc.end.column;
  return (startLine < inputLine && inputLine < endLine) ||
    (startLine === inputLine && startLine !== endLine && startColumn <= inputColumn) ||
    (endLine === inputLine && startLine !== endLine && endColumn >= inputColumn) ||
    (startLine === endLine && endLine === inputLine && startColumn <= inputColumn && inputColumn <= endColumn);
}
