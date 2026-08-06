import {
  parseBlockstateChoice,
  validateBlockstateChoiceEnd
} from "./blockstateChoiceParser";
import {
  isRemovedModelModifierProperty,
  recoverRemovedMultipartEntry,
  rejectRemovedModelModifierProperty
} from "./blockstateRemovedSyntaxRecovery";
import { parseBlockstateVariantEntry } from "./blockstateSelectorParser";
import {
  multipartBodyParseContext,
  variantsBodyParseContext,
  type BlockstateRootParseContext
} from "./bodyParseContext";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  MultipartBodyNode,
  MultipartSectionStatementNode,
  UnknownStmtNode,
  VariantBodyNode,
  VariantSectionStatementNode
} from "./types";

export function parseVariantBody(host: ResourceStatementParserHost): VariantBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedVariantBody", "Expected variants body.");
    return { kind: "VariantBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: VariantSectionStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseVariantEntryStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse variant statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after variants body.");
  return { kind: "VariantBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseMultipartBody(host: ResourceStatementParserHost): MultipartBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedMultipartBody", "Expected multipart body.");
    return { kind: "MultipartBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: MultipartSectionStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseMultipartEntryStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse multipart statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after multipart body.");
  return { kind: "MultipartBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseBlockstateVariantsRootBody(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateVariantsRootBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedBlockstateRootBody", "Expected blockstate variants body.");
    return { kind: "BlockstateVariantsRootBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: BlockstateVariantsRootStatementNode[] = [];
  let seenBase = false;
  let followsChoice = false;
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    const misplacedModifier: boolean = followsChoice && isRemovedModelModifierProperty(host);
    const statement: BlockstateVariantsRootStatementNode = misplacedModifier
      ? rejectRemovedModelModifierProperty(host)
      : parseVariantsRootStatement(host, context);
    seenBase = validateRootBase(host, statement, statements.length, seenBase, context.allowBase);
    statements.push(statement);
    followsChoice = statement.kind === "BlockstateVariantEntry" || misplacedModifier;
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse blockstate variants root statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after blockstate variants body.");
  return {
    kind: "BlockstateVariantsRootBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

export function parseBlockstateMultipartRootBody(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateMultipartRootBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedBlockstateRootBody", "Expected blockstate multipart body.");
    return { kind: "BlockstateMultipartRootBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: BlockstateMultipartRootStatementNode[] = [];
  let seenBase = false;
  let followsChoice = false;
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    const misplacedModifier: boolean = followsChoice && isRemovedModelModifierProperty(host);
    const statement: BlockstateMultipartRootStatementNode = misplacedModifier
      ? rejectRemovedModelModifierProperty(host)
      : parseMultipartRootStatement(host, context);
    seenBase = validateRootBase(host, statement, statements.length, seenBase, context.allowBase);
    statements.push(statement);
    followsChoice = statement.kind === "BlockstateMultipartEntry" || misplacedModifier;
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse blockstate multipart root statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after blockstate multipart body.");
  return {
    kind: "BlockstateMultipartRootBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseVariantsRootStatement(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateVariantsRootStatementNode {
  return isRootCommonStatementStart(host)
    ? host.parseBlockstateRootCommonStatement(context)
    : parseBlockstateVariantEntry(host);
}

function parseMultipartRootStatement(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateMultipartRootStatementNode {
  return isRootCommonStatementStart(host)
    ? host.parseBlockstateRootCommonStatement(context)
    : parseMultipartEntryStatement(host);
}

function parseVariantEntryStatement(host: ResourceStatementParserHost): VariantSectionStatementNode {
  switch (host.current().text) {
    case "let":
      return host.parseLetDecl();
    case "use":
      return host.parseUseDecl();
    case "for":
      return host.parseForStmt(variantsBodyParseContext);
    case "if":
      return host.parseIfStmt(variantsBodyParseContext);
    default:
      return parseBlockstateVariantEntry(host);
  }
}

function parseMultipartEntryStatement(host: ResourceStatementParserHost): MultipartSectionStatementNode {
  switch (host.current().text) {
    case "let":
      return host.parseLetDecl();
    case "use":
      return host.parseUseDecl();
    case "for":
      return host.parseForStmt(multipartBodyParseContext);
    case "if":
      return host.parseIfStmt(multipartBodyParseContext);
    default:
      return parseCanonicalMultipartEntry(host);
  }
}

function parseCanonicalMultipartEntry(
  host: ResourceStatementParserHost
): BlockstateMultipartEntryNode | UnknownStmtNode {
  const start = host.current();
  if (!host.matchText("part")) {
    const legacy = start.text === "when" || start.text === "apply";
    host.addDiagnosticAtCurrent(
      legacy ? "rsgl.legacyBlockstateMultipartEntry" : "rsgl.expectedBlockstatePart",
      legacy
        ? "'when ... apply' and 'apply ...' entries are no longer supported; use 'part when ... => ...' or 'part always => ...'."
        : "Expected a multipart blockstate entry beginning with 'part'."
    );
    if (legacy) {
      recoverRemovedMultipartEntry(host, start.text);
    } else {
      host.recoverToLineEnd();
    }
    return unknownMultipartEntry(host, start);
  }

  let predicate;
  let always = false;
  if (host.matchText("always")) {
    always = true;
  } else if (host.matchText("when")) {
    predicate = host.parseExpression({ stopTexts: ["=>", "->"] });
  } else {
    host.addDiagnosticAtCurrent(
      "rsgl.expectedBlockstatePartCondition",
      "Expected 'always' or 'when <predicate>' after 'part'."
    );
    host.recoverToLineEnd();
    return unknownMultipartEntry(host, start);
  }

  if (host.expectMappingArrow("blockstate multipart part") === "missing") {
    if (!host.isLineBoundaryOr("}", ",", ";")) {
      host.recoverToLineEnd();
    }
    return unknownMultipartEntry(host, start);
  }

  const choice = parseBlockstateChoice(host);
  validateBlockstateChoiceEnd(host);
  return {
    kind: "BlockstateMultipartEntry",
    keyword: start.text,
    predicate,
    always,
    choice,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function unknownMultipartEntry(
  host: ResourceStatementParserHost,
  start: ReturnType<ResourceStatementParserHost["current"]>
): UnknownStmtNode {
  return {
    kind: "UnknownStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function isRootCommonStatementStart(host: ResourceStatementParserHost): boolean {
  const text = host.current().text;
  return text === "let"
    || text === "use"
    || text === "for"
    || text === "if"
    || text === "base"
    || text === "merge"
    || (text === "[" && !isRemovedBracketedEntryStart(host))
    || host.peekText(1) === ":"
    || host.peekText(1) === "="
    || (text !== "[" && text !== "{" && text !== "(" && text !== "apply" && text !== "when"
      && text !== "case" && text !== "part"
      && text !== "variants" && text !== "multipart");
}

/** Keeps the removed `[state=value] -> model` surface on its directed recovery path. */
function isRemovedBracketedEntryStart(host: ResourceStatementParserHost): boolean {
  let squareDepth = 0;
  for (let ahead = 0; host.peekText(ahead) !== ""; ahead += 1) {
    const text = host.peekText(ahead);
    if (text === "[") {
      squareDepth += 1;
      continue;
    }
    if (text !== "]") {
      continue;
    }
    squareDepth -= 1;
    if (squareDepth === 0) {
      const next = host.peekText(ahead + 1);
      return next === "->" || next === "=>";
    }
  }
  return false;
}

function validateRootBase(
  host: ResourceStatementParserHost,
  statement: BlockstateVariantsRootStatementNode | BlockstateMultipartRootStatementNode,
  statementCount: number,
  seenBase: boolean,
  allowBase: boolean
): boolean {
  if (statement.kind !== "BaseStmt") {
    return seenBase;
  }
  if (!allowBase) {
    host.addDiagnostic(
      "rsgl.baseInvalidContext",
      "base is only valid at the start of a concrete blockstate resource root.",
      statement.range
    );
  } else if (seenBase) {
    host.addDiagnostic("rsgl.duplicateBase", "A blockstate root can contain at most one base statement.", statement.range);
  } else if (statementCount > 0) {
    host.addDiagnostic("rsgl.baseMustPrecedeBody", "The base statement must be the first root statement.", statement.range);
  }
  return true;
}
