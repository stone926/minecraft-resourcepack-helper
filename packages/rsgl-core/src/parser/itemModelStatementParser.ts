import { isRsglItemModelConstructorStart } from "../itemModelSyntax";
import { itemModelPropertyOptionVocabulary } from "../itemModelSchema";
import {
  compositeItemModelBodyParseContext,
  firstMatchItemModelBodyParseContext,
  itemModelTemplateBodyParseContext,
  rangeItemModelBodyParseContext,
  selectItemModelBodyParseContext
} from "./bodyParseContext";
import type { ResourceStatementParserHost } from "./statementParserHost";
import type { RsglArrowExpectation } from "./arrowSemantics";
import type {
  ExprNode,
  ItemCompositeBodyNode,
  ItemCompositeBodyStatementNode,
  ItemCompositeModelNode,
  ItemFallbackClauseNode,
  ItemFirstMatchBodyNode,
  ItemFirstMatchBodyStatementNode,
  ItemFirstMatchWhenNode,
  ItemModelCompositeNode,
  ItemModelConditionNode,
  ItemModelEmptyNode,
  ItemModelExprNode,
  ItemModelFirstMatchNode,
  ItemModelNode,
  ItemModelProducerStmtNode,
  ItemModelRangeNode,
  ItemModelSelectNode,
  ItemModelSelectedItemNode,
  ItemModelSpecialNode,
  ItemModelTemplateBodyNode,
  ItemModelTemplateBodyStatementNode,
  ItemModelUseNode,
  ItemOptionNode,
  ItemRangeBodyNode,
  ItemRangeBodyStatementNode,
  ItemRangeEntryNode,
  ItemRangeFramesNode,
  ItemSelectBodyNode,
  ItemSelectBodyStatementNode,
  ItemSelectCaseNode,
  ObjectExprNode,
  RsglToken,
  UseDeclNode,
  UnknownStmtNode
} from "./types";

const itemModelExpressionStops = ["with", ",", ";", "}"] as const;
const selectClauseStarts = new Set(["case", "fallback", "let", "for", "if"]);
const rangeClauseStarts = new Set(["entry", "frames", "fallback", "let", "for", "if"]);
const compositeClauseStarts = new Set(["model", "let", "for", "if"]);
const firstMatchClauseStarts = new Set(["when", "fallback", "let", "for", "if"]);
const conditionClauseStarts = new Set(["on_true", "on_false"]);

/** Parses a direct `/model` producer at an item root, when the contextual head is unambiguous. */
export function tryParseItemModelStatement(
  host: ResourceStatementParserHost
): ItemModelProducerStmtNode | undefined {
  const text = host.current().text;
  if (text === "model") {
    return parseRootModelExpressionProducer(host);
  }

  const terminal = text === "empty" || text === "selected_item";
  if (!terminal && !isRsglItemModelConstructorStart(text, host.peekText(1))) {
    return undefined;
  }

  const start = host.current();
  const value = parseItemModelNode(host, { allowBareTerminal: terminal });
  return producer(start, value, terminal ? "terminal" : "structured", host);
}

/** Parses one recursive item-model value without narrowing ordinary RSGL expressions. */
export function parseItemModelNode(
  host: ResourceStatementParserHost,
  options: { allowLeadingLineBreak?: boolean; allowBareTerminal?: boolean } = {}
): ItemModelNode {
  const text = host.current().text;
  if (text === "use" && looksLikeItemModelUse(host)) {
    return parseItemModelUse(host);
  }

  if (isRsglItemModelConstructorStart(text, host.peekText(1))) {
    switch (text) {
      case "range":
        return parseItemModelRange(host);
      case "select":
        return parseItemModelSelect(host);
      case "condition":
        return parseItemModelCondition(host);
      case "composite":
        return parseItemModelComposite(host);
      case "special":
        return parseItemModelSpecial(host);
      case "first_match":
        return parseItemModelFirstMatch(host);
      case "empty":
        return parseItemModelTerminal(host, "empty", false);
      case "selected_item":
        return parseItemModelTerminal(host, "selected_item", false);
      default:
        break;
    }
  }

  if (options.allowBareTerminal && (text === "empty" || text === "selected_item")) {
    return parseItemModelTerminal(host, text, true);
  }
  return parseItemModelExpression(host, options.allowLeadingLineBreak === true);
}

export function parseItemSelectBody(host: ResourceStatementParserHost): ItemSelectBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemSelectBody", "Expected item select body.");
    return { kind: "ItemSelectBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: ItemSelectBodyStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseItemSelectBodyStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse item select statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after item select body.");
  return { kind: "ItemSelectBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseItemRangeBody(host: ResourceStatementParserHost): ItemRangeBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemRangeBody", "Expected item range body.");
    return { kind: "ItemRangeBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: ItemRangeBodyStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseItemRangeBodyStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse item range statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after item range body.");
  return { kind: "ItemRangeBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseItemCompositeBody(host: ResourceStatementParserHost): ItemCompositeBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemCompositeBody", "Expected item composite body.");
    return { kind: "ItemCompositeBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: ItemCompositeBodyStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseItemCompositeBodyStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse item composite statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after item composite body.");
  return { kind: "ItemCompositeBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseItemFirstMatchBody(host: ResourceStatementParserHost): ItemFirstMatchBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemFirstMatchBody", "Expected item first_match body.");
    return { kind: "ItemFirstMatchBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: ItemFirstMatchBodyStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseItemFirstMatchBodyStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse item first_match statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after item first_match body.");
  return { kind: "ItemFirstMatchBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

export function parseItemModelTemplateBody(host: ResourceStatementParserHost): ItemModelTemplateBodyNode {
  const start = host.current();
  if (!host.matchText("{")) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemModelTemplateBody", "Expected item_model template body.");
    return { kind: "ItemModelTemplateBody", statements: [], ...host.nodeRanges(start, start) };
  }
  const statements: ItemModelTemplateBodyStatementNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    statements.push(parseItemModelTemplateBodyStatement(host));
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse item_model template statement; skipping token.");
  }
  host.expectText("}", "Expected '}' after item_model template body.");
  return { kind: "ItemModelTemplateBody", statements, ...host.nodeRanges(start, host.previousOr(start)) };
}

/**
 * Parses the shared statement-level `use` producer while retaining the item
 * model rule that template calls cannot acquire caller-side postfix options.
 */
export function parseItemModelUseDecl(host: ResourceStatementParserHost): UseDeclNode {
  const start = host.advance();
  const expression = host.parseExpression({ stopTexts: itemModelExpressionStops });
  rejectUnsupportedPostfixOptions(host, "item_model template call");
  return {
    kind: "UseDecl",
    keyword: start.text,
    expression,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseRootModelExpressionProducer(host: ResourceStatementParserHost): ItemModelProducerStmtNode {
  const start = host.advance();
  if (host.current().text === "use" && looksLikeItemModelUse(host)) {
    host.addDiagnosticAtCurrent(
      "rsgl.itemModelUseAfterRootModel",
      "An item root calls an item_model template with bare 'use'; 'model use ...' is only valid in a composite or frames slot."
    );
  } else if (isRsglItemModelConstructorStart(host.current().text, host.peekText(1))) {
    host.addDiagnosticAtCurrent(
      "rsgl.itemModelConstructorAfterRootModel",
      "Structured item-model producers are written directly without a root 'model' introducer."
    );
  }
  const value = parseItemModelNode(host);
  return producer(start, value, "modelExpression", host);
}

function producer(
  start: RsglToken,
  value: ItemModelNode,
  surfaceKind: ItemModelProducerStmtNode["surfaceKind"],
  host: ResourceStatementParserHost
): ItemModelProducerStmtNode {
  return {
    kind: "ItemModelProducerStmt",
    keyword: start.text,
    value,
    surfaceKind,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelExpression(
  host: ResourceStatementParserHost,
  allowLeadingLineBreak: boolean
): ItemModelExprNode {
  const start = host.current();
  const expression = host.parseExpression({
    stopTexts: itemModelExpressionStops,
    allowLeadingLineBreak
  });
  const options = parsePostfixOptions(host, "item model expression");
  return {
    kind: "ItemModelExpr",
    expression,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelUse(host: ResourceStatementParserHost): ItemModelUseNode {
  const start = host.advance();
  const expression = host.parseExpression({ stopTexts: itemModelExpressionStops, allowLeadingLineBreak: true });
  rejectUnsupportedPostfixOptions(host, "item_model template call");
  return {
    kind: "ItemModelUse",
    expression,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelRange(host: ResourceStatementParserHost): ItemModelRangeNode {
  const start = host.advance();
  const { property, propertyOptions } = parseItemModelHeader(
    host,
    "range",
    itemModelPropertyOptionVocabulary.range_dispatch
  );
  const body = parseItemRangeBody(host);
  const options = parsePostfixOptions(host, "item range model");
  return {
    kind: "ItemModelRange",
    property,
    propertyOptions,
    body,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelSelect(host: ResourceStatementParserHost): ItemModelSelectNode {
  const start = host.advance();
  const { property, propertyOptions } = parseItemModelHeader(
    host,
    "select",
    itemModelPropertyOptionVocabulary.select
  );
  const body = parseItemSelectBody(host);
  const options = parsePostfixOptions(host, "item select model");
  return {
    kind: "ItemModelSelect",
    property,
    propertyOptions,
    body,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelCondition(host: ResourceStatementParserHost): ItemModelConditionNode {
  const start = host.advance();
  const { property, propertyOptions } = parseItemModelHeader(
    host,
    "condition",
    itemModelPropertyOptionVocabulary.condition
  );
  let onTrue: ItemModelNode | undefined;
  let onFalse: ItemModelNode | undefined;
  if (host.matchText("{")) {
    while (!host.isAtEnd() && host.current().text !== "}") {
      const mark = host.mark();
      if (host.current().text === "on_true" || host.current().text === "on_false") {
        const branch = host.advance().text;
        const model = parseRequiredItemModel(host, conditionClauseStarts, `item condition ${branch}`);
        if (branch === "on_true") {
          onTrue = model;
        } else {
          onFalse = model;
        }
      } else {
        rejectBodyStatement(host, "rsgl.unexpectedItemConditionStatement", "Expected 'on_true' or 'on_false' in item condition body.");
      }
      host.consumeOptionalSeparator();
      host.ensureProgress(mark, "Unable to parse item condition statement; skipping token.");
    }
    host.expectText("}", "Expected '}' after item condition body.");
  } else {
    host.addDiagnosticAtCurrent("rsgl.expectedItemConditionBody", "Expected item condition body.");
  }
  const options = parsePostfixOptions(host, "item condition model");
  return {
    kind: "ItemModelCondition",
    property,
    propertyOptions,
    onTrue,
    onFalse,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelComposite(host: ResourceStatementParserHost): ItemModelCompositeNode {
  const start = host.advance();
  const body = parseItemCompositeBody(host);
  const options = parsePostfixOptions(host, "item composite model");
  return {
    kind: "ItemModelComposite",
    body,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelFirstMatch(host: ResourceStatementParserHost): ItemModelFirstMatchNode {
  const start = host.advance();
  const body = parseItemFirstMatchBody(host);
  const options = parsePostfixOptions(host, "item first_match model");
  return {
    kind: "ItemModelFirstMatch",
    body,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelSpecial(host: ResourceStatementParserHost): ItemModelSpecialNode {
  const start = host.advance();
  host.expectText("base", "Expected 'base' in item special model.");
  const base = host.parseExpression({ stopTexts: ["model"] });
  host.expectText("model", "Expected 'model' in item special model.");
  const model = host.current().text === "{"
    ? host.parseObjectExpression()
    : host.parseExpression({ stopTexts: itemModelExpressionStops });
  const options = parsePostfixOptions(host, "item special model");
  return {
    kind: "ItemModelSpecial",
    base,
    model,
    options,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelTerminal(
  host: ResourceStatementParserHost,
  terminal: "empty" | "selected_item",
  allowBare: boolean
): ItemModelEmptyNode | ItemModelSelectedItemNode {
  const start = host.advance();
  if (host.current().text === "{") {
    if (host.peekText(1) !== "}") {
      host.addDiagnosticAtCurrent(
        "rsgl.nonEmptyItemTerminalBody",
        `Item ${terminal} must use an empty '{}' body.`
      );
    }
    host.consumeBalancedEnclosure("{", "}", `Expected '}' after item ${terminal}.`);
  } else if (!allowBare) {
    host.addDiagnosticAtCurrent("rsgl.expectedItemTerminalBody", `Expected '{}' after item ${terminal}.`);
  }
  rejectUnsupportedPostfixOptions(host, `item ${terminal}`);
  return terminal === "empty"
    ? { kind: "ItemModelEmpty", ...host.nodeRanges(start, host.previousOr(start)) }
    : { kind: "ItemModelSelectedItem", ...host.nodeRanges(start, host.previousOr(start)) };
}

function parseItemSelectBodyStatement(host: ResourceStatementParserHost): ItemSelectBodyStatementNode {
  switch (host.current().text) {
    case "case":
      return parseItemSelectCase(host);
    case "fallback":
      return parseItemFallback(host, selectClauseStarts, "item select fallback");
    case "let":
      return host.parseLetDecl();
    case "for":
      return host.parseForStmt(selectItemModelBodyParseContext);
    case "if":
      return host.parseIfStmt(selectItemModelBodyParseContext);
    default:
      return rejectBodyStatement(host, "rsgl.unexpectedItemSelectStatement", "Expected 'case', 'fallback', 'let', 'for', or 'if' in item select body.");
  }
}

function parseItemRangeBodyStatement(host: ResourceStatementParserHost): ItemRangeBodyStatementNode {
  switch (host.current().text) {
    case "entry":
      return parseItemRangeEntry(host);
    case "frames":
      return parseItemRangeFrames(host);
    case "fallback":
      return parseItemFallback(host, rangeClauseStarts, "item range fallback");
    case "let":
      return host.parseLetDecl();
    case "for":
      return host.parseForStmt(rangeItemModelBodyParseContext);
    case "if":
      return host.parseIfStmt(rangeItemModelBodyParseContext);
    default:
      return rejectBodyStatement(host, "rsgl.unexpectedItemRangeStatement", "Expected 'entry', 'frames', 'fallback', 'let', 'for', or 'if' in item range body.");
  }
}

function parseItemCompositeBodyStatement(host: ResourceStatementParserHost): ItemCompositeBodyStatementNode {
  switch (host.current().text) {
    case "model":
      return parseItemCompositeModel(host);
    case "let":
      return host.parseLetDecl();
    case "for":
      return host.parseForStmt(compositeItemModelBodyParseContext);
    case "if":
      return host.parseIfStmt(compositeItemModelBodyParseContext);
    default:
      return rejectBodyStatement(host, "rsgl.unexpectedItemCompositeStatement", "Expected 'model', 'let', 'for', or 'if' in item composite body.");
  }
}

function parseItemFirstMatchBodyStatement(host: ResourceStatementParserHost): ItemFirstMatchBodyStatementNode {
  switch (host.current().text) {
    case "when":
      return parseItemFirstMatchWhen(host);
    case "fallback":
      return parseItemFallback(host, firstMatchClauseStarts, "item first_match fallback");
    case "let":
      return host.parseLetDecl();
    case "for":
      return host.parseForStmt(firstMatchItemModelBodyParseContext);
    case "if":
      return host.parseIfStmt(firstMatchItemModelBodyParseContext);
    default:
      return rejectBodyStatement(host, "rsgl.unexpectedItemFirstMatchStatement", "Expected 'when', 'fallback', 'let', 'for', or 'if' in item first_match body.");
  }
}

function parseItemModelTemplateBodyStatement(
  host: ResourceStatementParserHost
): ItemModelTemplateBodyStatementNode {
  switch (host.current().text) {
    case "let":
      return host.parseLetDecl();
    case "use":
      return parseItemModelUseDecl(host);
    case "for":
      return host.parseForStmt(itemModelTemplateBodyParseContext);
    case "if":
      return host.parseIfStmt(itemModelTemplateBodyParseContext);
    default: {
      const producerStatement = tryParseItemModelStatement(host);
      return producerStatement ?? rejectBodyStatement(
        host,
        "rsgl.unexpectedItemModelTemplateStatement",
        "Expected one item-model producer, 'use', 'let', 'for', or 'if' in an item_model template body."
      );
    }
  }
}

function parseItemSelectCase(host: ResourceStatementParserHost): ItemSelectCaseNode {
  const start = host.advance();
  const when = host.parseExpression({ stopTexts: ["=>", "->"] });
  const arrow = host.expectMappingArrow("item select case");
  const model = parseRequiredItemModel(host, selectClauseStarts, "item select case", arrow);
  return {
    kind: "ItemSelectCase",
    keyword: start.text,
    when,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemRangeEntry(host: ResourceStatementParserHost): ItemRangeEntryNode {
  const start = host.advance();
  const threshold = host.parseExpression({ stopTexts: ["=>", "->"] });
  const arrow = host.expectMappingArrow("item range entry");
  const model = parseRequiredItemModel(host, rangeClauseStarts, "item range entry", arrow);
  return {
    kind: "ItemRangeEntry",
    keyword: start.text,
    threshold,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemRangeFrames(host: ResourceStatementParserHost): ItemRangeFramesNode {
  const start = host.advance();
  const frames = host.parseExpression({ stopTexts: ["model"] });
  host.expectText("model", "Expected 'model' in item range frames clause.");
  const model = parseRequiredItemModel(host, rangeClauseStarts, "item range frames");
  return {
    kind: "ItemRangeFrames",
    keyword: start.text,
    frames,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemCompositeModel(host: ResourceStatementParserHost): ItemCompositeModelNode {
  const start = host.advance();
  const model = parseRequiredItemModel(host, compositeClauseStarts, "item composite model");
  return {
    kind: "ItemCompositeModel",
    keyword: start.text,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemFirstMatchWhen(host: ResourceStatementParserHost): ItemFirstMatchWhenNode {
  const start = host.advance();
  const { property, propertyOptions } = parseItemModelHeader(
    host,
    "first_match",
    itemModelPropertyOptionVocabulary.condition,
    ["=>", "->"]
  );
  const arrow = host.expectMappingArrow("item first_match when");
  const model = parseRequiredItemModel(host, firstMatchClauseStarts, "item first_match when", arrow);
  return {
    kind: "ItemFirstMatchWhen",
    keyword: start.text,
    property,
    propertyOptions,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemFallback(
  host: ResourceStatementParserHost,
  clauseStarts: ReadonlySet<string>,
  context: string
): ItemFallbackClauseNode {
  const start = host.advance();
  const model = parseRequiredItemModel(host, clauseStarts, context);
  return {
    kind: "ItemFallbackClause",
    keyword: start.text,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseRequiredItemModel(
  host: ResourceStatementParserHost,
  clauseStarts: ReadonlySet<string>,
  context: string,
  arrow?: RsglArrowExpectation
): ItemModelNode {
  const current = host.current();
  const missing = current.text === "}"
    || current.text === ","
    || current.text === ";"
    // After the canonical arrow, a contextual clause word on the next line is
    // still a valid identifier-valued RHS (for example `=>\n fallback`). The
    // boundary heuristic is only needed when the arrow itself was absent or
    // recovered from the wrong spelling.
    || (arrow !== "expected" && host.isLineBoundaryOr() && clauseStarts.has(current.text));
  if (!missing) {
    return parseItemModelNode(host, { allowLeadingLineBreak: true });
  }
  // A missing arrow already explains an absent mapping RHS. If an arrow was
  // consumed (including the recoverable wrong spelling), retain the shared
  // expression diagnostic used by match/blockstate recovery.
  if (arrow !== "missing") {
    host.addDiagnosticAtCurrent(
      arrow ? "rsgl.expectedExpression" : "rsgl.expectedItemModel",
      arrow
        ? `Expected an item-model node after the mapping arrow in ${context}.`
        : `Expected an item-model node after ${context}.`
    );
  }
  const expression = host.missingExprAt(current);
  return {
    kind: "ItemModelExpr",
    expression,
    ...host.nodeRanges(current, current)
  };
}

function parseItemModelHeader(
  host: ResourceStatementParserHost,
  owner: "range" | "select" | "condition" | "first_match",
  optionKeywords: readonly string[],
  additionalStops: readonly string[] = []
): { property: ExprNode; propertyOptions: ItemOptionNode[] } {
  host.expectText("property", `Expected 'property' in item ${owner} model.`);
  const terminalStops = ["{", ...additionalStops];
  // Property and option expressions remain the full RSGL expression grammar.
  // Option words delimit only a syntactically complete outer expression, so
  // they remain legal identifiers at the start and in operands/nested values.
  const property = host.parseExpression({
    stopTexts: terminalStops,
    contextualStopTexts: optionKeywords
  });
  const propertyOptions: ItemOptionNode[] = [];
  const terminalStopSet = new Set(terminalStops);
  while (!host.isAtEnd() && !terminalStopSet.has(host.current().text)) {
    const mark = host.mark();
    const start = host.current();
    const name = host.parseIdentifier(`Expected item ${owner} option name.`);
    if (!name) {
      host.recoverToLineEnd();
      host.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
      continue;
    }
    const value = host.parseExpression({
      stopTexts: terminalStops,
      contextualStopTexts: optionKeywords
    });
    propertyOptions.push({
      kind: "ItemOption",
      name,
      value,
      ...host.nodeRanges(start, host.previousOr(start))
    });
    host.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
  }
  return { property, propertyOptions };
}

function parsePostfixOptions(
  host: ResourceStatementParserHost,
  owner: string
): ObjectExprNode | undefined {
  if (!host.matchText("with")) {
    return undefined;
  }
  if (host.current().text === "{") {
    return host.parseObjectExpression();
  }
  host.addDiagnosticAtCurrent("rsgl.expectedItemModelOptions", `Expected an object after 'with' on ${owner}.`);
  return undefined;
}

function rejectUnsupportedPostfixOptions(host: ResourceStatementParserHost, owner: string): void {
  if (!host.matchText("with")) {
    return;
  }
  host.addDiagnosticAtCurrent(
    "rsgl.itemModelOptionsNotSupported",
    `${owner} does not accept postfix item-model options.`
  );
  if (host.current().text === "{") {
    host.parseObjectExpression();
  }
}

function looksLikeItemModelUse(host: ResourceStatementParserHost): boolean {
  if (host.current().text !== "use") {
    return false;
  }
  let offset = 1;
  const text = host.peekText(offset);
  if (!text || isCallPunctuation(text)) {
    return false;
  }
  offset++;
  while (host.peekText(offset) === ".") {
    const member = host.peekText(offset + 1);
    if (!member || isCallPunctuation(member)) {
      return false;
    }
    offset += 2;
  }
  return host.peekText(offset) === "(";
}

function isCallPunctuation(text: string): boolean {
  return text === "(" || text === ")" || text === "{" || text === "}" || text === "," || text === ";";
}

function rejectBodyStatement(
  host: ResourceStatementParserHost,
  code: string,
  message: string
): UnknownStmtNode {
  const start = host.current();
  host.addDiagnosticAtCurrent(code, message);
  host.recoverToLineEnd();
  return {
    kind: "UnknownStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}
