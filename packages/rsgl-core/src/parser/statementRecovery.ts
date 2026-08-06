import type { ResourceStatementParserHost } from "./statementParserHost";

/** Recovers one malformed statement while preserving the next line or separator-delimited statement. */
export function recoverInvalidStatement(host: ResourceStatementParserHost): void {
  if (consumeCurrentEnclosure(host)) {
    recoverUnexpectedStatementTail(host);
    return;
  }
  if (!host.isAtEnd() && host.current().text !== "}") {
    host.advance();
  }
  recoverUnexpectedStatementTail(host);
}

/** Consumes an unexpected statement tail without crossing a line or explicit separator. */
export function recoverUnexpectedStatementTail(host: ResourceStatementParserHost): void {
  while (
    !host.isAtEnd()
    && host.current().text !== "}"
    && host.current().text !== ","
    && host.current().text !== ";"
    && !host.isLineBoundaryOr()
  ) {
    if (!consumeCurrentEnclosure(host)) {
      host.advance();
    }
  }
}

function consumeCurrentEnclosure(host: ResourceStatementParserHost): boolean {
  const enclosure = statementEnclosures.get(host.current().text);
  if (!enclosure) {
    return false;
  }
  host.consumeBalancedEnclosure(enclosure.open, enclosure.close, enclosure.message);
  return true;
}

const statementEnclosures = new Map([
  ["{", { open: "{", close: "}", message: "Expected '}' after malformed statement." }],
  ["[", { open: "[", close: "]", message: "Expected ']' after malformed statement." }],
  ["(", { open: "(", close: ")", message: "Expected ')' after malformed statement." }]
]);
