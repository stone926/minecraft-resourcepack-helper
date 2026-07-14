import { parseBlockstateApplyValue } from "./blockstateApplyParser";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type { BlockstateVariantEntryNode, UnknownStmtNode } from "./types";

export type ParsedVariantEntry = BlockstateVariantEntryNode | UnknownStmtNode;

export function parseBlockstateVariantEntry(host: ResourceStatementParserHost): ParsedVariantEntry {
  const start = host.current();
  const selectorSyntax = start.text === "{"
    ? "inlineObject" as const
    : start.text === "("
      ? "parenthesizedExpression" as const
      : undefined;
  const selector = host.parseExpression({ stopTexts: [":"] });

  if (!selectorSyntax) {
    host.addDiagnostic(
      "rsgl.expectedBlockstateSelector",
      "Blockstate variant selectors must be an inline object or a parenthesized expression.",
      selector.range
    );
    consumeRejectedEntryTail(host);
    return unknownVariantEntry(host, start);
  }

  if (!host.expectText(":", "Expected ':' after blockstate selector.")) {
    consumeRejectedEntryTail(host);
    return unknownVariantEntry(host, start);
  }
  return {
    kind: "BlockstateVariantEntry",
    keyword: "variant",
    selector,
    selectorSyntax,
    value: parseBlockstateApplyValue(host),
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function consumeRejectedEntryTail(host: ResourceStatementParserHost): void {
  if (host.isLineBoundaryOr("}")) {
    return;
  }
  if (host.current().text === "{") {
    host.consumeBalancedBlock("Expected '}' after malformed blockstate entry.");
    return;
  }
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    host.advance();
  }
}

function unknownVariantEntry(
  host: ResourceStatementParserHost,
  start: ReturnType<ResourceStatementParserHost["current"]>
): UnknownStmtNode {
  return {
    kind: "UnknownStmt",
    keyword: "variant",
    ...host.nodeRanges(start, host.previousOr(start))
  };
}
