import { Position, Range } from "vscode";
import { JsonAstNode } from "./jsonAst";

export function rangeInsideString(node: JsonAstNode): Range | null {
  if (!node?.loc) {
    return null;
  }

  return new Range(
    new Position(node.loc.start.line - 1, node.loc.start.column),
    new Position(node.loc.end.line - 1, Math.max(node.loc.start.column, node.loc.end.column - 2))
  );
}
