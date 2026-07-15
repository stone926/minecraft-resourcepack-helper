import { choiceBodyParseContext } from "./bodyParseContext";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateChoiceBodyNode,
  BlockstateChoiceNode,
  BlockstateChoiceStatementNode,
  BlockstateModelSpecNode,
  BlockstateRandomChoiceNode,
  BlockstateRandomOptionNode,
  UnknownStmtNode
} from "./types";

const modelHeadTerminators = ["with", "weight", ",", ";", "}"] as const;

/** Parses the only two blockstate choice forms: a model spec or a random block. */
export function parseBlockstateChoice(host: ResourceStatementParserHost): BlockstateChoiceNode {
  if (host.current().text === "random") {
    if (host.peekText(1) === "[") {
      return rejectLegacyRandomList(host);
    }
    return parseBlockstateRandomChoice(host);
  }
  return parseBlockstateModelSpec(host);
}

export function parseBlockstateChoiceBody(host: ResourceStatementParserHost): BlockstateChoiceBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedBlockstateChoiceBody", "Expected a blockstate choice body.");
    return {
      kind: "BlockstateChoiceBody",
      statements: [],
      ...host.nodeRanges(start, start)
    };
  }

  const statements: BlockstateChoiceStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseBlockstateChoiceStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse blockstate choice statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after blockstate choice body.");
  return {
    kind: "BlockstateChoiceBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseBlockstateChoiceStatement(host: ResourceStatementParserHost): BlockstateChoiceStatementNode {
  switch (host.current().text) {
    case "option":
      return parseBlockstateRandomOption(host);
    case "let":
      return host.parseLetDecl();
    case "use":
      return host.parseUseDecl();
    case "for":
      return host.parseForStmt(choiceBodyParseContext);
    case "if":
      return host.parseIfStmt(choiceBodyParseContext);
    default:
      return rejectChoiceStatement(host);
  }
}

function parseBlockstateModelSpec(host: ResourceStatementParserHost): BlockstateModelSpecNode {
  const start = host.current();
  if (host.isAtEnd() || start.text === "}" || (
    host.isLineBoundaryOr()
    && isBlockstateStatementStart(start.text)
  )) {
    host.addDiagnosticAtCurrent(
      "rsgl.expectedBlockstateModel",
      "Expected a model expression in the blockstate choice."
    );
    const model = host.missingExprAt(start);
    return { kind: "BlockstateModelSpec", model, ...host.nodeRanges(start, start) };
  }

  const legacyObjectOrList = start.text === "{" || start.text === "[";
  if (legacyObjectOrList) {
    host.addDiagnosticAtCurrent(
      "rsgl.legacyBlockstateModelValue",
      "Blockstate model objects and arrays are no longer supported; use a model expression with 'with { ... }' or a random block."
    );
  }

  const model = host.parseExpression({ stopTexts: modelHeadTerminators });
  let options;
  if (host.matchText("with")) {
    if (host.current().text === "{") {
      options = host.parseObjectExpression();
    } else {
      host.addDiagnosticAtCurrent(
        "rsgl.expectedBlockstateModelOptions",
        "Expected an object after 'with' in a blockstate model specification."
      );
    }
  }

  return {
    kind: "BlockstateModelSpec",
    model,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function isBlockstateStatementStart(text: string): boolean {
  return text === "case"
    || text === "part"
    || text === "option"
    || text === "let"
    || text === "use"
    || text === "for"
    || text === "if"
    || text === "base"
    || text === "merge";
}

function parseBlockstateRandomChoice(host: ResourceStatementParserHost): BlockstateRandomChoiceNode {
  const start = host.advance();
  const body = parseBlockstateChoiceBody(host);
  if (body.statements.length === 0) {
    host.addDiagnostic(
      "rsgl.emptyBlockstateRandomChoice",
      "A random blockstate choice must contain at least one option or choice-producing control statement.",
      body.range
    );
  }
  return {
    kind: "BlockstateRandomChoice",
    body,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseBlockstateRandomOption(host: ResourceStatementParserHost): BlockstateRandomOptionNode {
  const start = host.advance();
  let model: BlockstateModelSpecNode;
  if (host.current().text === "random") {
    host.addDiagnosticAtCurrent(
      "rsgl.nestedBlockstateChoice",
      "A random option must contain one model specification, not a nested random choice."
    );
    const nested = parseBlockstateChoice(host);
    model = {
      kind: "BlockstateModelSpec",
      model: host.missingExprAt(nested),
      range: nested.range,
      fullRange: nested.fullRange
    };
  } else {
    model = parseBlockstateModelSpec(host);
  }

  const weight = host.matchText("weight")
    ? host.parseExpression({ stopTexts: [",", ";", "}"] })
    : undefined;

  validateStatementEnd(
    host,
    "rsgl.unexpectedBlockstateOptionTail",
    "Unexpected tokens after a random option; use 'with { ... }' for model options and 'weight <expression>' for its weight."
  );

  return {
    kind: "BlockstateRandomOption",
    keyword: start.text,
    model,
    weight,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function rejectLegacyRandomList(host: ResourceStatementParserHost): BlockstateModelSpecNode {
  const start = host.advance();
  host.addDiagnostic(
    "rsgl.legacyBlockstateRandomList",
    "'random [...]' is no longer supported; use 'random { option ... }'.",
    { start: start.offset, end: start.offset + start.length }
  );
  host.consumeBalancedEnclosure("[", "]", "Expected ']' after the legacy random list.");
  return {
    kind: "BlockstateModelSpec",
    model: host.missingExprAt(start),
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function rejectChoiceStatement(host: ResourceStatementParserHost): UnknownStmtNode {
  const start = host.current();
  host.addDiagnosticAtCurrent(
    "rsgl.expectedBlockstateRandomOption",
    "Expected 'option', 'let', 'use', 'for', or 'if' in a blockstate random choice."
  );
  if (start.text === "random" && host.peekText(1) === "{") {
    parseBlockstateRandomChoice(host);
  } else {
    host.recoverToLineEnd();
  }
  return {
    kind: "UnknownStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

/** Ensures removed trailing `x=...`/`weight=...` forms cannot become sibling statements. */
export function validateBlockstateChoiceEnd(host: ResourceStatementParserHost): void {
  if (host.current().text === "weight") {
    validateStatementEnd(
      host,
      "rsgl.blockstateWeightInvalidContext",
      "weight is only valid after an option inside a random choice."
    );
    return;
  }
  validateStatementEnd(
    host,
    "rsgl.legacyBlockstateModelModifiers",
    "Trailing blockstate model modifiers are no longer supported; use 'with { ... }'."
  );
}

function validateStatementEnd(host: ResourceStatementParserHost, code: string, message: string): void {
  if (host.isLineBoundaryOr("}", ",", ";")) {
    return;
  }
  host.addDiagnosticAtCurrent(code, message);
  host.recoverToLineEnd();
}
