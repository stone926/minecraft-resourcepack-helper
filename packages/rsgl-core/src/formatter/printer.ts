import type { RsglToken } from "../parser";
import {
  consumeRsglClosingDelimiter,
  createRsglDelimiterStack,
  pushRsglOpeningDelimiter,
  rsglLeadingDelimiterDepth,
  type RsglDelimiterStack
} from "./delimiterStack";
import type {
  RsglFormatDocument,
  RsglFormatItem,
  RsglFormatLine
} from "./lines";
import { createRsglFormatLine, wholeTokenItems } from "./lines";
import { maximumRsglFormattedDelimiterDepth } from "./limits";
import type { RsglFormatOptions, RsglFormattingStyleRules } from "./options";
import { renderRsglLineContent } from "./spacing";
import type { RsglFormatterSyntaxFacts } from "./syntaxFacts";

export function printRsglFormatDocument(
  document: RsglFormatDocument,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions,
  rules: Readonly<RsglFormattingStyleRules>
): string {
  normalizeFinalNewlines(document, options);
  const indentation = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  const indentCache = [""];
  const delimiterStack = createRsglDelimiterStack();
  const output: string[] = [];

  for (const line of document.lines) {
    let content = renderRsglLineContent(line, facts, rules);
    if (options.trimTrailingWhitespace && !line.separatorProtected) {
      content = content.trimEnd();
    } else if (!options.trimTrailingWhitespace) {
      content += line.originalTrailingWhitespace;
    }

    if (content.length > 0 && !line.preserveLeadingText) {
      const depth = leadingLineDepth(delimiterStack, line.items);
      output.push(indentForDepth(depth, indentation, indentCache), content);
    } else {
      output.push(content);
    }

    updateDelimiterStack(
      delimiterStack,
      wholeTokenItems(line).map(item => item.token)
    );
    if (line.separator !== undefined) {
      output.push(line.separator);
    }
  }
  return output.join("");
}

function leadingLineDepth(
  stack: RsglDelimiterStack,
  items: readonly RsglFormatItem[]
): number {
  const leadingClosers: string[] = [];
  for (const item of items) {
    if (item.kind !== "token" || item.position !== "whole") {
      break;
    }
    leadingClosers.push(item.token.text);
  }
  return rsglLeadingDelimiterDepth(stack, leadingClosers);
}

function updateDelimiterStack(
  stack: RsglDelimiterStack,
  tokens: readonly RsglToken[]
): void {
  for (const token of tokens) {
    if (pushRsglOpeningDelimiter(stack, token.text)) {
      continue;
    }
    consumeRsglClosingDelimiter(stack, token.text);
  }
}

function indentForDepth(
  depth: number,
  indentation: string,
  cache: string[]
): string {
  const boundedDepth = Math.min(depth, maximumRsglFormattedDelimiterDepth);
  while (cache.length <= boundedDepth) {
    cache.push(cache[cache.length - 1] + indentation);
  }
  return cache[boundedDepth];
}

function normalizeFinalNewlines(
  document: RsglFormatDocument,
  options: RsglFormatOptions
): void {
  if (hasUnterminatedVerbatimAtEof(document.lines)) {
    return;
  }
  if (options.trimFinalNewlines) {
    removeFinalNewlines(document.lines);
  }
  if (options.insertFinalNewline === true && !endsWithNewline(document.lines)) {
    const last = document.lines[document.lines.length - 1];
    last.separator = document.preferredEol;
    last.separatorProtected = false;
    document.lines.push(createRsglFormatLine());
  }
}

function removeFinalNewlines(lines: RsglFormatLine[]): void {
  while (lines.length > 1) {
    const last = lines[lines.length - 1];
    const previous = lines[lines.length - 2];
    if (
      last.items.length > 0
      || previous.separator === undefined
      || previous.separatorProtected
    ) {
      break;
    }
    previous.separator = undefined;
    lines.pop();
  }
}

function endsWithNewline(lines: readonly RsglFormatLine[]): boolean {
  if (lines.length < 2) {
    return false;
  }
  const last = lines[lines.length - 1];
  const previous = lines[lines.length - 2];
  return last.items.length === 0 && previous.separator !== undefined;
}

function hasUnterminatedVerbatimAtEof(lines: readonly RsglFormatLine[]): boolean {
  const lastItem = [...lines].reverse()
    .flatMap(line => [...line.items].reverse())
    .find((item): item is RsglFormatItem => item.text.length > 0 || item.kind === "token");
  if (!lastItem) {
    return false;
  }
  if (lastItem.kind === "token" && lastItem.token.kind === "templateString") {
    return !lastItem.token.text.endsWith("`");
  }
  if (lastItem.kind === "comment" && lastItem.commentKind === "blockComment") {
    return !lastItem.text.endsWith("*/");
  }
  return false;
}
