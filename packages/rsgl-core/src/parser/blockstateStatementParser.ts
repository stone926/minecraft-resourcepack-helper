import { ResourceStatementParserHost } from "./statementParserHost";
import {
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionNode,
  MultipartSectionStatementNode,
  VariantBodyNode,
  VariantEntryNode,
  VariantsSectionNode,
  VariantSectionStatementNode
} from "./types";

export function parseVariantBody(host: ResourceStatementParserHost): VariantBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    return {
      kind: "VariantBody",
      statements: [],
      ...host.nodeRanges(start, start)
    };
  }

  const statements: VariantSectionStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseVariantSectionStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse variant statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after variants body.");
  return {
    kind: "VariantBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

export function parseMultipartBody(host: ResourceStatementParserHost): MultipartBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    return {
      kind: "MultipartBody",
      statements: [],
      ...host.nodeRanges(start, start)
    };
  }

  const statements: MultipartSectionStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseMultipartSectionStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse multipart statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after multipart body.");
  return {
    kind: "MultipartBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

export function parseVariantsSection(host: ResourceStatementParserHost): VariantsSectionNode {
  const start = host.advance();
  const entries: VariantSectionStatementNode[] = [];
  host.expectText("{", "Expected variants body.");
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    entries.push(parseVariantSectionStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse variant entry; skipping token.");
  }
  host.expectText("}", "Expected '}' after variants.");
  return {
    kind: "VariantsSection",
    keyword: start.text,
    entries,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

export function parseMultipartSection(host: ResourceStatementParserHost): MultipartSectionNode {
  const start = host.advance();
  const entries: MultipartSectionStatementNode[] = [];
  host.expectText("{", "Expected multipart body.");
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    entries.push(parseMultipartSectionStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse multipart entry; skipping token.");
  }
  host.expectText("}", "Expected '}' after multipart.");
  return {
    kind: "MultipartSection",
    keyword: start.text,
    entries,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseVariantSectionStatement(host: ResourceStatementParserHost): VariantSectionStatementNode {
  switch (host.current().text) {
    case "let":
      return host.parseLetDecl();
    case "use":
      return host.parseUseDecl();
    case "for":
      return host.parseForStmt("variants");
    case "if":
      return host.parseIfStmt("variants");
    default:
      return parseVariantEntry(host);
  }
}

function parseMultipartSectionStatement(host: ResourceStatementParserHost): MultipartSectionStatementNode {
  switch (host.current().text) {
    case "let":
      return host.parseLetDecl();
    case "use":
      return host.parseUseDecl();
    case "for":
      return host.parseForStmt("multipart");
    case "if":
      return host.parseIfStmt("multipart");
    default:
      return parseMultipartEntry(host);
  }
}

function parseVariantEntry(host: ResourceStatementParserHost): VariantEntryNode {
  const start = host.current();
  const state = host.parseExpression({ stopTexts: ["->"] });
  const hasArrow = host.expectText("->", "Expected '->' in variant entry.");
  const value = hasArrow
    ? host.parseBlockstateEntryValue()
    : recoverMalformedEntryValue(host);
  return {
    kind: "VariantEntry",
    keyword: "variant",
    state,
    value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseMultipartEntry(host: ResourceStatementParserHost): MultipartEntryNode {
  const start = host.current();
  let when;
  if (host.matchText("when")) {
    when = host.parseExpression({ stopTexts: ["apply"] });
  }
  const hasApply = host.expectText("apply", "Expected 'apply' in multipart entry.");
  const apply = hasApply
    ? host.parseBlockstateEntryValue()
    : recoverMalformedEntryValue(host);
  return {
    kind: "MultipartEntry",
    keyword: "multipartEntry",
    when,
    apply,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function recoverMalformedEntryValue(host: ResourceStatementParserHost) {
  const value = host.missingExprAt(host.current());
  if (host.current().text === "{") {
    host.consumeBalancedBlock("Expected '}' after malformed entry block.");
  } else {
    host.recoverToLineEnd();
  }
  return value;
}
