import {
  parseBlockstateChoice,
  validateBlockstateChoiceEnd
} from "./blockstateChoiceParser";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateVariantEntryNode,
  BlockstateWildcardSelectorNode,
  UnknownStmtNode
} from "./types";

export type ParsedVariantEntry = BlockstateVariantEntryNode | UnknownStmtNode;

export function parseBlockstateVariantEntry(host: ResourceStatementParserHost): ParsedVariantEntry {
  const start = host.current();
  if (!host.matchText("case")) {
    rejectMissingCase(host, start.text === "{" || start.text === "(");
    return unknownVariantEntry(host, start);
  }

  const selector = host.matchText("*")
    ? wildcardSelector(host, host.previousOr(start))
    : host.parseExpression({ stopTexts: ["=>"] });

  if (selector.kind === "ObjectExpr" && selector.properties.length === 0) {
    host.addDiagnostic(
      "rsgl.emptyBlockstateSelector",
      "An empty selector object is not supported; use 'case *' for the wildcard selector.",
      selector.range
    );
  }

  if (!host.expectText("=>", "Expected '=>' after blockstate selector.")) {
    consumeRejectedEntryTail(host);
    return unknownVariantEntry(host, start);
  }

  const choice = parseBlockstateChoice(host);
  validateBlockstateChoiceEnd(host);
  return {
    kind: "BlockstateVariantEntry",
    keyword: start.text,
    selector,
    choice,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function wildcardSelector(
  host: ResourceStatementParserHost,
  token: ReturnType<ResourceStatementParserHost["current"]>
): BlockstateWildcardSelectorNode {
  return {
    kind: "BlockstateWildcardSelector",
    ...host.nodeRanges(token, token)
  };
}

function rejectMissingCase(host: ResourceStatementParserHost, legacyShape: boolean): void {
  host.addDiagnosticAtCurrent(
    legacyShape ? "rsgl.legacyBlockstateVariantEntry" : "rsgl.expectedBlockstateCase",
    legacyShape
      ? "Selector-colon blockstate entries are no longer supported; use 'case <selector> => <choice>'."
      : "Expected a blockstate variant entry beginning with 'case'."
  );
  consumeRejectedEntryTail(host);
}

function consumeRejectedEntryTail(host: ResourceStatementParserHost): void {
  if (host.isLineBoundaryOr("}")) {
    return;
  }
  if (host.current().text === "{") {
    host.consumeBalancedBlock("Expected '}' after malformed blockstate entry.");
    host.recoverToLineEnd();
    return;
  }
  host.recoverToLineEnd();
}

function unknownVariantEntry(
  host: ResourceStatementParserHost,
  start: ReturnType<ResourceStatementParserHost["current"]>
): UnknownStmtNode {
  return {
    kind: "UnknownStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}
