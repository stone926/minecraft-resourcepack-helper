export function isInArea(inputLine: number, inputColumn: number, astLoc: {
  start: { line: number, column: number }, end: { line: number, column: number }
}): boolean {
  const startLine: number = astLoc.start.line;
  const endLine: number = astLoc.end.line;
  const startColumn: number = astLoc.start.column;
  const endColumn: number = astLoc.end.column;
  return  (startLine < inputLine && inputLine < endLine) ||
  (startLine === inputLine && startColumn <= inputColumn) ||
  (endLine === inputLine && endColumn >= inputColumn);
}