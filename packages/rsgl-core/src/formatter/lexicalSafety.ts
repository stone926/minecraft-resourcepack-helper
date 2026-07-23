import type { RsglToken } from "../parser";

const compoundOperators = [
  "...",
  "->",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  ".."
];

export function crossesCompoundOperatorBoundary(
  left: string,
  right: string
): boolean {
  return compoundOperators.some(operator => {
    for (let split = 1; split < operator.length; split++) {
      if (
        left.endsWith(operator.slice(0, split))
        && right.startsWith(operator.slice(split))
      ) {
        return true;
      }
    }
    return false;
  });
}

export function tightOperatorWouldRetokenize(
  left: RsglToken,
  operator: RsglToken,
  right: RsglToken
): boolean {
  return (
    (
      left.kind === "resourceLocation"
      && (operator.text === "." || operator.text === "..")
    )
    || crossesCompoundOperatorBoundary(left.text, operator.text)
    || crossesCompoundOperatorBoundary(operator.text, right.text)
  );
}
