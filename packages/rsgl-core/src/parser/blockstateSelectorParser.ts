import { parseBlockstateApplyValue, parseLegacyBlockstateApplyValue } from "./blockstateApplyParser";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateVariantEntryNode,
  StateKeySugarNode,
  VariantEntryNode
} from "./types";

export type ParsedVariantEntry = BlockstateVariantEntryNode | VariantEntryNode;

export function parseBlockstateVariantEntry(host: ResourceStatementParserHost): ParsedVariantEntry {
  const start = host.current();
  if (start.text === "[") {
    const state = host.parseLegacyStateKeySugar() as StateKeySugarNode;
    host.addDiagnostic(
      "rsgl.legacyStateKeySugar",
      "The '[key=value]' blockstate selector syntax is deprecated. Use an object selector and computed keys where needed.",
      state.range,
      "warning"
    );
    if (host.matchText("->")) {
      addLegacyArrowDiagnostic(host, host.previousOr(start));
    } else {
      host.expectText(":", "Expected ':' after blockstate selector.");
    }
    return legacyVariantEntry(host, start, state);
  }

  const selectorSyntax = start.text === "{"
    ? "inlineObject" as const
    : start.text === "("
      ? "parenthesizedExpression" as const
      : undefined;
  const selector = host.parseExpression({ stopTexts: [":", "->"] });

  if (host.matchText("->")) {
    addLegacyArrowDiagnostic(host, host.previousOr(start));
    return legacyVariantEntry(host, start, selector);
  }

  if (!selectorSyntax) {
    host.addDiagnostic(
      "rsgl.expectedBlockstateSelector",
      "Blockstate variant selectors must be an inline object or a parenthesized expression.",
      selector.range
    );
  }
  host.expectText(":", "Expected ':' after blockstate selector.");

  if (!selectorSyntax) {
    return legacyVariantEntry(host, start, selector);
  }
  const parsedValue = parseBlockstateApplyValue(host);
  if (parsedValue.syntax === "legacy") {
    return {
      kind: "VariantEntry",
      keyword: "variant",
      syntax: "legacy",
      state: selector,
      value: parsedValue.value,
      ...host.nodeRanges(start, host.previousOr(start))
    };
  }
  return {
    kind: "BlockstateVariantEntry",
    keyword: "variant",
    selector,
    selectorSyntax,
    value: parsedValue.value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function legacyVariantEntry(
  host: ResourceStatementParserHost,
  start: ReturnType<ResourceStatementParserHost["current"]>,
  state: VariantEntryNode["state"]
): VariantEntryNode {
  const value = parseLegacyBlockstateApplyValue(host);
  return {
    kind: "VariantEntry",
    keyword: "variant",
    syntax: "legacy",
    state,
    value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function addLegacyArrowDiagnostic(
  host: ResourceStatementParserHost,
  arrow: ReturnType<ResourceStatementParserHost["current"]>
): void {
  host.addDiagnostic(
    "rsgl.legacyBlockstateEntryArrow",
    "The '->' blockstate entry separator is deprecated. Use ':'.",
    { start: arrow.offset, end: arrow.offset + arrow.length },
    "warning"
  );
}
