import { Position, Range } from "vscode";
import type { ResourceReferenceValueNode } from "./resourceReferences";

export function rangeInsideString(node: ResourceReferenceValueNode): Range | null {
  if (node.valueLoc) {
    return rangeFromLocation(node.valueLoc);
  }

  if (!node.loc) {
    return null;
  }

  const loc = node.loc;
  return new Range(
    new Position(loc.start.line - 1, loc.start.column),
    new Position(loc.end.line - 1, Math.max(loc.start.column, loc.end.column - 2))
  );
}

function rangeFromLocation(loc: NonNullable<ResourceReferenceValueNode["valueLoc"]>): Range {
  return new Range(
    new Position(loc.start.line - 1, loc.start.column),
    new Position(loc.end.line - 1, loc.end.column)
  );
}
