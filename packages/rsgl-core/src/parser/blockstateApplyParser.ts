import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateApplyExprNode,
  BlockstateApplyValueNode,
  BlockstateModelPropertyNode,
  BlockstateRandomItemNode,
  BlockstateRandomValueNode
} from "./types";

const applyTerminators = [",", "]", "}"] as const;

/** Parses the canonical, non-expression blockstate apply domain. */
export function parseBlockstateApplyValue(
  host: ResourceStatementParserHost
): BlockstateApplyValueNode {
  if (host.current().text === "}" || (
    host.isLineBoundaryOr() && looksLikeOuterBlockstateStatement(host)
  )) {
    host.addDiagnosticAtCurrent(
      "rsgl.expectedBlockstateApplyValue",
      "Expected a blockstate model value after the selector."
    );
    return missingCanonicalApplyValue(host);
  }
  if (host.current().text === "random" && host.peekText(1) === "[") {
    return parseBlockstateRandomValue(host);
  }
  return parseBlockstateApplyExpression(host);
}

function parseBlockstateApplyExpression(host: ResourceStatementParserHost): BlockstateApplyExprNode {
  const start = host.current();
  const head = host.parseExpression({ stopTexts: applyTerminators });
  if (head.kind === "MissingExpr") {
    while (!host.isAtEnd() && !host.isLineBoundaryOr(...applyTerminators)) {
      host.advance();
    }
  }
  const properties = head.kind === "MissingExpr" ? [] : parseCanonicalProperties(host);
  return {
    kind: "BlockstateApplyExpr",
    head,
    properties,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseBlockstateRandomValue(host: ResourceStatementParserHost): BlockstateRandomValueNode {
  const start = host.advance();
  const items: BlockstateRandomItemNode[] = [];
  if (!host.matchText("[")) {
    host.addDiagnosticAtCurrent("rsgl.expectedBlockstateRandomList", "Expected '[' after random.");
  }
  while (!host.isAtEnd() && host.current().text !== "]") {
    const mark = host.mark();
    items.push(parseBlockstateRandomItem(host));
    const comma = host.matchText(",");
    if (!comma) {
      if (host.current().text === "]" || host.current().text === "}") {
        break;
      }
      if (host.isLineBoundaryOr() && looksLikeOuterBlockstateStatement(host)) {
        break;
      }
      if (!host.isLineBoundaryOr()) {
        host.addDiagnosticAtCurrent(
          "rsgl.expectedBlockstateRandomSeparator",
          "Expected ',' or a line break between blockstate random items."
        );
      }
    }
    host.ensureProgress(mark, "Unable to parse blockstate random item; skipping token.");
  }
  host.expectText("]", "Expected ']' after blockstate random items.");
  return {
    kind: "BlockstateRandomValue",
    items,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseBlockstateRandomItem(host: ResourceStatementParserHost): BlockstateRandomItemNode {
  const start = host.current();
  if (start.text === "random" && host.peekText(1) === "[") {
    host.addDiagnostic(
      "rsgl.nestedBlockstateModelList",
      "A blockstate random item cannot contain a nested random value.",
      { start: start.offset, end: start.offset + start.length }
    );
    parseBlockstateRandomValue(host);
    return {
      kind: "BlockstateRandomItem",
      head: host.missingExprAt(start),
      properties: [],
      ...host.nodeRanges(start, host.previousOr(start))
    };
  }
  const head = host.parseExpression({ stopTexts: applyTerminators });
  if (head.kind === "MissingExpr") {
    while (!host.isAtEnd() && !host.isLineBoundaryOr(...applyTerminators)) {
      host.advance();
    }
  }
  const properties = head.kind === "MissingExpr" ? [] : parseCanonicalProperties(host);
  return {
    kind: "BlockstateRandomItem",
    head,
    properties,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseCanonicalProperties(host: ResourceStatementParserHost): BlockstateModelPropertyNode[] {
  const properties: BlockstateModelPropertyNode[] = [];
  while (
    !host.isLineBoundaryOr(...applyTerminators)
    && host.peekText(1) === "="
  ) {
    const start = host.current();
    const name = host.parseIdentifier("Expected blockstate model property name.");
    if (!name) {
      break;
    }
    host.matchText("=");
    const value = host.isLineBoundaryOr(...applyTerminators)
      ? host.missingExprAt(host.current())
      : host.parseExpression({ stopTexts: applyTerminators });
    if (value.kind === "MissingExpr") {
      host.addDiagnostic(
        "rsgl.expectedBlockstateModelPropertyValue",
        `Expected value for blockstate model property '${name.text}'.`,
        { start: name.range.end, end: name.range.end }
      );
    }
    properties.push({
      kind: "BlockstateModelProperty",
      name,
      value,
      ...host.nodeRanges(start, host.previousOr(start))
    });
  }
  return properties;
}

function missingCanonicalApplyValue(host: ResourceStatementParserHost): BlockstateApplyExprNode {
  const token = host.current();
  return {
    kind: "BlockstateApplyExpr",
    head: host.missingExprAt(token),
    properties: [],
    ...host.nodeRanges(token, token)
  };
}

function looksLikeOuterBlockstateStatement(host: ResourceStatementParserHost): boolean {
  const current = host.current().text;
  if (current === "apply" || current === "when"
    || current === "let" || current === "use" || current === "for" || current === "if"
    || current === "base" || current === "merge" || current === "variants" || current === "multipart") {
    return true;
  }
  if (current !== "{" && current !== "(" && current !== "[") {
    return false;
  }
  const closing = current === "{" ? "}" : current === "(" ? ")" : "]";
  const stack = [closing];
  for (let ahead = 1; ahead < 4096; ahead++) {
    const text = host.peekText(ahead);
    if (!text) {
      return false;
    }
    if (text === "{" || text === "(" || text === "[") {
      stack.push(text === "{" ? "}" : text === "(" ? ")" : "]");
      continue;
    }
    if (text !== stack[stack.length - 1]) {
      continue;
    }
    stack.pop();
    if (stack.length === 0) {
      const separator = host.peekText(ahead + 1);
      return separator === ":" || separator === "->";
    }
  }
  return false;
}
