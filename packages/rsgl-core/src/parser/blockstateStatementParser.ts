import { parseBlockstateApplyValue, parseLegacyBlockstateApplyValue } from "./blockstateApplyParser";
import { parseBlockstateVariantEntry } from "./blockstateSelectorParser";
import {
  multipartBodyParseContext,
  variantsBodyParseContext,
  type BlockstateRootParseContext,
  type LegacyBlockstateRootParseContext
} from "./bodyParseContext";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type {
  BlockstateMultipartEntryNode,
  BlockstateMultipartRootBodyNode,
  BlockstateMultipartRootStatementNode,
  BlockstateVariantsRootBodyNode,
  BlockstateVariantsRootStatementNode,
  LegacyBlockstateRootBodyNode,
  LegacyBlockstateRootStatementNode,
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionNode,
  MultipartSectionStatementNode,
  VariantBodyNode,
  VariantsSectionNode,
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
    statements.push(parseMultipartEntryStatement(host, false));
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
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    const statement = parseVariantsRootStatement(host, context);
    seenBase = validateRootBase(host, statement, statements.length, seenBase, context.allowBase);
    statements.push(statement);
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
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    const statement = parseMultipartRootStatement(host, context);
    seenBase = validateRootBase(host, statement, statements.length, seenBase, context.allowBase);
    statements.push(statement);
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

export function parseLegacyBlockstateRootBody(
  host: ResourceStatementParserHost,
  context: LegacyBlockstateRootParseContext
): LegacyBlockstateRootBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedBlockstateRootBody", "Expected blockstate body.");
    return { kind: "LegacyBlockstateRootBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: LegacyBlockstateRootStatementNode[] = [];
  let seenBase = false;
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    const statement = parseLegacyRootStatement(host, context);
    seenBase = validateRootBase(host, statement, statements.length, seenBase, context.allowBase);
    statements.push(statement);
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse legacy blockstate root statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after blockstate body.");
  return {
    kind: "LegacyBlockstateRootBody",
    statements,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

/** Legacy nested variants wrapper retained as an ordered root operation. */
export function parseVariantsSection(host: ResourceStatementParserHost): VariantsSectionNode {
  const start = host.advance();
  addLegacyWrapperDiagnostic(host, start, "variants");
  const entries: VariantSectionStatementNode[] = [];
  host.expectText("{", "Expected variants body.");
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    entries.push(parseVariantEntryStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse variant entry; skipping token.");
  }
  host.expectText("}", "Expected '}' after variants.");
  return {
    kind: "VariantsSection",
    keyword: start.text,
    syntax: "legacyWrapper",
    entries,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

/** Legacy nested multipart wrapper retained as an ordered root operation. */
export function parseMultipartSection(host: ResourceStatementParserHost): MultipartSectionNode {
  const start = host.advance();
  addLegacyWrapperDiagnostic(host, start, "multipart");
  const entries: MultipartSectionStatementNode[] = [];
  host.expectText("{", "Expected multipart body.");
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    entries.push(parseMultipartEntryStatement(host, true));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse multipart entry; skipping token.");
  }
  host.expectText("}", "Expected '}' after multipart.");
  return {
    kind: "MultipartSection",
    keyword: start.text,
    syntax: "legacyWrapper",
    entries,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseVariantsRootStatement(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateVariantsRootStatementNode {
  if (isLegacyWrapperStart(host, "variants")) {
    return parseVariantsSection(host);
  }
  if (isLegacyWrapperStart(host, "multipart")) {
    return parseMultipartSection(host);
  }
  return isRootCommonStatementStart(host)
    ? host.parseBlockstateRootCommonStatement(context)
    : parseBlockstateVariantEntry(host);
}

function parseMultipartRootStatement(
  host: ResourceStatementParserHost,
  context: BlockstateRootParseContext
): BlockstateMultipartRootStatementNode {
  if (isLegacyWrapperStart(host, "multipart")) {
    return parseMultipartSection(host);
  }
  if (isLegacyWrapperStart(host, "variants")) {
    return parseVariantsSection(host);
  }
  return isRootCommonStatementStart(host)
    ? host.parseBlockstateRootCommonStatement(context)
    : parseMultipartEntryStatement(host, false);
}

function parseLegacyRootStatement(
  host: ResourceStatementParserHost,
  context: LegacyBlockstateRootParseContext
): LegacyBlockstateRootStatementNode {
  if (isLegacyWrapperStart(host, "variants")) {
    return parseVariantsSection(host);
  }
  if (isLegacyWrapperStart(host, "multipart")) {
    return parseMultipartSection(host);
  }
  if (host.current().text === "{" || host.current().text === "(" || host.current().text === "[") {
    return parseBlockstateVariantEntry(host);
  }
  if (host.current().text === "apply" || host.current().text === "when") {
    return parseMultipartEntryStatement(host, false);
  }
  return host.parseBlockstateRootCommonStatement(context);
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

function parseMultipartEntryStatement(
  host: ResourceStatementParserHost,
  legacyContainer: boolean
): MultipartSectionStatementNode {
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
      return legacyContainer ? parseLegacyMultipartEntry(host) : parseCanonicalMultipartEntry(host);
  }
}

function parseCanonicalMultipartEntry(
  host: ResourceStatementParserHost
): BlockstateMultipartEntryNode | MultipartEntryNode {
  const start = host.current();
  let when;
  if (host.matchText("when")) {
    when = host.parseExpression({ stopTexts: ["apply"] });
  }
  const hasApply = host.expectText("apply", "Expected 'apply' in multipart entry.");
  if (!hasApply) {
    const missing = host.missingExprAt(host.current());
    return {
      kind: "BlockstateMultipartEntry",
      keyword: "multipartEntry",
      when,
      apply: {
        kind: "BlockstateApplyExpr",
        head: missing,
        properties: [],
        range: missing.range,
        fullRange: missing.fullRange
      },
      ...host.nodeRanges(start, host.previousOr(start))
    };
  }
  const parsed = parseBlockstateApplyValue(host);
  if (parsed.syntax === "legacy") {
    return {
      kind: "MultipartEntry",
      keyword: "multipartEntry",
      syntax: "legacy",
      when,
      apply: parsed.value,
      ...host.nodeRanges(start, host.previousOr(start))
    };
  }
  return {
    kind: "BlockstateMultipartEntry",
    keyword: "multipartEntry",
    when,
    apply: parsed.value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseLegacyMultipartEntry(host: ResourceStatementParserHost): MultipartEntryNode {
  const start = host.current();
  let when;
  if (host.matchText("when")) {
    when = host.parseExpression({ stopTexts: ["apply"] });
  }
  const hasApply = host.expectText("apply", "Expected 'apply' in multipart entry.");
  const apply = hasApply
    ? parseLegacyBlockstateApplyValue(host)
    : host.missingExprAt(host.current());
  return {
    kind: "MultipartEntry",
    keyword: "multipartEntry",
    syntax: "legacy",
    when,
    apply,
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
    || host.peekText(1) === ":"
    || host.peekText(1) === "="
    || (text !== "{" && text !== "(" && text !== "[" && text !== "apply" && text !== "when");
}

function isLegacyWrapperStart(
  host: ResourceStatementParserHost,
  mode: "variants" | "multipart"
): boolean {
  return host.current().text === mode
    && host.peekText(1) === "{";
}

function addLegacyWrapperDiagnostic(
  host: ResourceStatementParserHost,
  token: ReturnType<ResourceStatementParserHost["current"]>,
  mode: "variants" | "multipart"
): void {
  host.addDiagnostic(
    "rsgl.legacyBlockstateWrapper",
    `The nested '${mode}' blockstate wrapper is deprecated. Move '${mode}' to the blockstate declaration header.`,
    { start: token.offset, end: token.offset + token.length },
    "warning"
  );
}

function validateRootBase(
  host: ResourceStatementParserHost,
  statement: LegacyBlockstateRootStatementNode,
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
