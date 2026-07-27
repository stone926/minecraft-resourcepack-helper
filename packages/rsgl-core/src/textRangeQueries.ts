import type { TextRange } from "./parser/types";

/**
 * Returns whether an offset touches a text range, inclusive at both edges so
 * a cursor sitting immediately before or after the text still matches.
 */
export function touchesRange(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}
