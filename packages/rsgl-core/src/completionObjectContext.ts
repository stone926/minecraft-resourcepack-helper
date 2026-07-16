import { lexRsgl } from "./parser";

/** Keeps field completions out of object values and nested calls. */
export function isObjectPropertyKeyPosition(bodyPrefix: string): boolean {
  const tokens = lexRsgl(bodyPrefix).tokens.filter(token => token.kind !== "endOfFile");
  let depth = 0;
  let segmentStart = 0;
  let lastTokenEnd = 0;

  for (const token of tokens) {
    if (depth === 0 && token.leadingTrivia.some(trivia => trivia.kind === "newline")) {
      segmentStart = token.offset;
    }
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      depth++;
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && (token.text === "," || token.text === ";")) {
      segmentStart = token.offset + token.length;
    }
    lastTokenEnd = token.offset + token.length;
  }

  if (depth !== 0) {
    return false;
  }
  const trailingText = bodyPrefix.slice(lastTokenEnd);
  const trailingLineBreak = Math.max(trailingText.lastIndexOf("\n"), trailingText.lastIndexOf("\r"));
  if (trailingLineBreak >= 0) {
    segmentStart = lastTokenEnd + trailingLineBreak + 1;
  }
  const segment = bodyPrefix.slice(segmentStart).trim();
  return segment.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment);
}
