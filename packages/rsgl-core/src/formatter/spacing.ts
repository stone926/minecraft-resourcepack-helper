import type { RsglToken } from "../parser";
import type {
  RsglFormatCommentFragment,
  RsglFormatItem,
  RsglFormatLine,
  RsglFormatTokenFragment
} from "./lines";
import type { RsglFormattingStyleRules } from "./options";
import type { RsglFormatterSyntaxFacts } from "./syntaxFacts";
import { crossesCompoundOperatorBoundary } from "./lexicalSafety";

const alwaysSpacedOperators = new Set([
  "=",
  "=>",
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "%",
  "|",
  "<",
  ">"
]);

const conditionallySpacedOperators = new Set(["-", "*", "/"]);
const openingDelimiters = new Set(["(", "[", "{"]);
const closingDelimiters = new Set([")", "]", "}"]);

export function renderRsglLineContent(
  line: RsglFormatLine,
  facts: RsglFormatterSyntaxFacts,
  rules: Readonly<RsglFormattingStyleRules>
): string {
  let result = "";
  let previous: BoundaryItem | undefined;

  for (const item of line.items) {
    if (hasOpeningBoundary(item)) {
      result += spacingBetween(previous, item, facts, rules);
    }
    result += item.text;
    previous = hasClosingBoundary(item) ? item : undefined;
  }

  return result;
}

type BoundaryItem = RsglFormatTokenFragment | RsglFormatCommentFragment;

function spacingBetween(
  previous: BoundaryItem | undefined,
  current: BoundaryItem,
  facts: RsglFormatterSyntaxFacts,
  rules: Readonly<RsglFormattingStyleRules>
): string {
  if (!previous) {
    return "";
  }
  if (previous.kind === "comment" || current.kind === "comment") {
    return commentSpacing(previous, current);
  }

  const left = previous.token;
  const right = current.token;
  if (facts.tightTokenPairs.has(left.offset)) {
    return "";
  }
  if (facts.unaryOperatorOffsets.has(left.offset)) {
    return crossesCompoundOperatorBoundary(left.text, right.text) ? " " : "";
  }
  const leftText = left.text;
  const rightText = right.text;
  if (rightText === "," || rightText === ";") {
    return "";
  }
  if (leftText === "," || leftText === ";") {
    return closingDelimiters.has(rightText) ? "" : " ";
  }
  if (leftText === "..." || leftText === "#" || leftText === "@") {
    return "";
  }
  if (rightText === "...") {
    return openingDelimiters.has(leftText) ? "" : " ";
  }
  if (rightText === ":") {
    return facts.spacedOperatorOffsets.has(right.offset) ? " " : "";
  }
  if (leftText === ":") {
    return " ";
  }
  if (rightText === "?") {
    return facts.spacedOperatorOffsets.has(right.offset) ? " " : "";
  }
  if (leftText === "?") {
    return facts.spacedOperatorOffsets.has(left.offset) ? " " : "";
  }
  if (leftText === "(" || leftText === "[") {
    return "";
  }
  if (leftText === "{") {
    return rightText === "}" ? "" : rules.spaceInsideBraces ? " " : "";
  }
  if (rightText === ")" || rightText === "]") {
    return "";
  }
  if (rightText === "}") {
    return leftText === "{" ? "" : rules.spaceInsideBraces ? " " : "";
  }
  if (rightText === "(") {
    return (isWordLike(left) && left.kind !== "keyword")
      || closingDelimiters.has(leftText)
      || facts.unaryOperatorOffsets.has(left.offset)
      ? ""
      : " ";
  }
  if (rightText === "[") {
    return facts.indexOpenOffsets.has(right.offset) ? "" : " ";
  }
  if (rightText === "{") {
    return " ";
  }
  if (
    facts.spacedOperatorOffsets.has(left.offset)
    || facts.spacedOperatorOffsets.has(right.offset)
  ) {
    return " ";
  }
  if (alwaysSpacedOperators.has(leftText) || alwaysSpacedOperators.has(rightText)) {
    return " ";
  }
  if (
    conditionallySpacedOperators.has(leftText)
    || conditionallySpacedOperators.has(rightText)
  ) {
    return " ";
  }
  if (leftText === "!") {
    return crossesCompoundOperatorBoundary(leftText, rightText) ? " " : "";
  }
  if (rightText === "#" || rightText === "@") {
    return isWordLike(left) || closingDelimiters.has(leftText) ? " " : "";
  }
  if (rightText === "!") {
    return isWordLike(left) || closingDelimiters.has(leftText) ? " " : "";
  }
  if (isWordLike(left) && isWordLike(right)) {
    return " ";
  }
  return wereOriginallyAdjacent(left, right) ? "" : " ";
}

function commentSpacing(previous: BoundaryItem, current: BoundaryItem): string {
  if (current.kind === "comment") {
    if (current.commentKind === "lineComment" && previous.kind !== "comment") {
      return "  ";
    }
    return previous.kind === "comment" && previous.commentKind === "lineComment"
      ? ""
      : " ";
  }
  return previous.kind === "comment" && previous.commentKind === "blockComment"
    ? " "
    : "";
}

function hasOpeningBoundary(item: RsglFormatItem): item is BoundaryItem {
  return item.position === "whole" || item.position === "start";
}

function hasClosingBoundary(item: RsglFormatItem): item is BoundaryItem {
  return item.position === "whole" || item.position === "end";
}

function isWordLike(token: RsglToken): boolean {
  return token.kind === "identifier"
    || token.kind === "keyword"
    || token.kind === "resourceLocation"
    || token.kind === "string"
    || token.kind === "templateString"
    || token.kind === "number";
}

function wereOriginallyAdjacent(left: RsglToken, right: RsglToken): boolean {
  return left.offset + left.length === right.offset;
}
