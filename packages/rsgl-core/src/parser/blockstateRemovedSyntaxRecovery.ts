import { blockstateModelOptionNames } from "../blockstateModelOptions";
import { blockstateModelOptionMessages } from "../diagnosticMessages";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type { UnknownStmtNode } from "./types";

/** Consumes one removed multipart entry without reconstructing any legacy AST. */
export function recoverRemovedMultipartEntry(
  host: ResourceStatementParserHost,
  entryKeyword: string
): void {
  host.advance();
  if (entryKeyword === "when" && !consumeConditionThroughApply(host)) {
    return;
  }
  consumeApplyValue(host);
}

export function isRemovedModelModifierProperty(host: ResourceStatementParserHost): boolean {
  return blockstateModelModifierNames.has(host.current().text)
    && (host.peekText(1) === ":" || host.peekText(1) === "=");
}

/** Rejects a separated modifier that would otherwise become a root JSON property. */
export function rejectRemovedModelModifierProperty(
  host: ResourceStatementParserHost
): UnknownStmtNode {
  const start = host.advance();
  const weight = start.text === "weight";
  host.addDiagnostic(
    weight ? "rsgl.blockstateWeightInvalidContext" : "rsgl.legacyBlockstateModelModifiers",
    weight
      ? blockstateModelOptionMessages.weightOutsideRandomChoice
      : `Trailing blockstate model modifier '${start.text}' is no longer supported; attach it to the preceding model with 'with { ${start.text}: ... }'.`,
    host.nodeRanges(start, start).range
  );
  host.advance();
  host.parseExpression();
  return {
    kind: "UnknownStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function consumeConditionThroughApply(host: ResourceStatementParserHost): boolean {
  while (!host.isAtEnd() && host.current().text !== "}") {
    if (host.current().text === "apply") {
      host.advance();
      return true;
    }
    if (host.current().text === "," || host.current().text === ";") {
      return false;
    }
    if (host.isLineBoundaryOr() && isMultipartStatementBoundary(host.current().text)) {
      return false;
    }
    if (consumeCurrentEnclosure(host)) {
      continue;
    }
    host.advance();
  }
  return false;
}

function consumeApplyValue(host: ResourceStatementParserHost): void {
  if (
    host.isAtEnd()
    || host.current().text === "}"
    || (host.isLineBoundaryOr() && isMultipartStatementBoundary(host.current().text))
  ) {
    return;
  }

  let consumed = false;
  while (!host.isAtEnd() && host.current().text !== "}") {
    if (
      consumed
      && (host.isLineBoundaryOr() || host.current().text === "," || host.current().text === ";")
    ) {
      return;
    }
    if (host.current().text === "random" && host.peekText(1) === "[") {
      host.advance();
      host.consumeBalancedEnclosure("[", "]", "Expected ']' after the removed random list.");
    } else if (!consumeCurrentEnclosure(host)) {
      host.advance();
    }
    consumed = true;
  }
}

function consumeCurrentEnclosure(host: ResourceStatementParserHost): boolean {
  const enclosure = removedSyntaxEnclosures.get(host.current().text);
  if (!enclosure) {
    return false;
  }
  host.consumeBalancedEnclosure(enclosure.open, enclosure.close, enclosure.message);
  return true;
}

function isMultipartStatementBoundary(text: string): boolean {
  return text === "part"
    || text === "let"
    || text === "use"
    || text === "for"
    || text === "if"
    || text === "base"
    || text === "merge";
}

const removedSyntaxEnclosures = new Map([
  ["{", { open: "{", close: "}", message: "Expected '}' after the removed blockstate object." }],
  ["[", { open: "[", close: "]", message: "Expected ']' after the removed blockstate list." }],
  ["(", { open: "(", close: ")", message: "Expected ')' after the removed blockstate expression." }]
]);

const blockstateModelModifierNames = new Set([...blockstateModelOptionNames, "weight"]);
