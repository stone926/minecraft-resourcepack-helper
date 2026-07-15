import {
  itemConditionOptionKeywords,
  itemRangeOptionKeywords,
  itemSelectOptionKeywords
} from "./statementKeywords";
import { ResourceStatementParserHost } from "./statementParserHost";
import {
  ExprNode,
  ItemConditionStmtNode,
  ItemCompositeStmtNode,
  ItemEmptyStmtNode,
  ItemOptionNode,
  ItemRangeFramesNode,
  ItemRangeStmtNode,
  ItemSelectCaseNode,
  ItemSelectedItemStmtNode,
  ItemSelectStmtNode,
  ItemSpecialStmtNode,
  ResourceStatementNode
} from "./types";

export function tryParseItemModelStatement(
  host: ResourceStatementParserHost
): ResourceStatementNode | undefined {
  switch (host.current().text) {
    case "range":
      return parseItemRangeStmt(host);
    case "select":
      return parseItemSelectStmt(host);
    case "condition":
      return parseItemConditionStmt(host);
    case "composite":
      return parseItemCompositeStmt(host);
    case "empty":
      return parseItemEmptyStmt(host);
    case "selected_item":
      return parseItemSelectedItemStmt(host);
    case "special":
      return parseItemSpecialStmt(host);
    default:
      return undefined;
  }
}

function parseItemRangeStmt(host: ResourceStatementParserHost): ItemRangeStmtNode {
  const start = host.advance();
  const { property, options } = parseItemModelStatementHeader(host, "range", itemRangeOptionKeywords);
  let frames: ItemRangeFramesNode | undefined;
  let fallback: ExprNode | undefined;

  if (host.matchText("{")) {
    while (!host.isAtEnd() && host.current().text !== "}") {
      const mark = host.mark();
      if (host.current().text === "frames") {
        frames = parseItemRangeFrames(host);
      } else if (host.current().text === "fallback") {
        host.advance();
        fallback = host.parseExpression({ stopTexts: [] });
      } else {
        host.addDiagnosticAtCurrent("rsgl.unexpectedItemRangeStatement", "Expected 'frames' or 'fallback' in item range body.");
        host.recoverToLineEnd();
      }
      host.ensureProgress(mark, "Unable to parse item range statement; skipping token.");
    }
    host.expectText("}", "Expected '}' after item range body.");
  } else {
    host.addDiagnosticAtCurrent("rsgl.expectedItemRangeBody", "Expected item range body.");
  }

  return {
    kind: "ItemRangeStmt",
    keyword: start.text,
    property,
    options,
    frames,
    fallback,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemRangeFrames(host: ResourceStatementParserHost): ItemRangeFramesNode {
  const start = host.advance();
  const frames = host.parseExpression({ stopTexts: ["model"] });
  host.expectText("model", "Expected 'model' in item range frames clause.");
  const model = host.parseExpression({ stopTexts: [] });
  return {
    kind: "ItemRangeFrames",
    frames,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemSelectStmt(host: ResourceStatementParserHost): ItemSelectStmtNode {
  const start = host.advance();
  const { property, options } = parseItemModelStatementHeader(host, "select", itemSelectOptionKeywords);
  const cases: ItemSelectCaseNode[] = [];
  let fallback: ExprNode | undefined;

  if (host.matchText("{")) {
    while (!host.isAtEnd() && host.current().text !== "}") {
      const mark = host.mark();
      if (host.current().text === "case") {
        cases.push(parseItemSelectCase(host));
      } else if (host.current().text === "fallback") {
        host.advance();
        fallback = host.parseExpression({ stopTexts: [] });
      } else {
        host.addDiagnosticAtCurrent("rsgl.unexpectedItemSelectStatement", "Expected 'case' or 'fallback' in item select body.");
        host.recoverToLineEnd();
      }
      host.consumeOptionalSeparator();
      host.ensureProgress(mark, "Unable to parse item select statement; skipping token.");
    }
    host.expectText("}", "Expected '}' after item select body.");
  } else {
    host.addDiagnosticAtCurrent("rsgl.expectedItemSelectBody", "Expected item select body.");
  }

  return {
    kind: "ItemSelectStmt",
    keyword: start.text,
    property,
    options,
    cases,
    fallback,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemSelectCase(host: ResourceStatementParserHost): ItemSelectCaseNode {
  const start = host.advance();
  const when = host.parseExpression({ stopTexts: ["=>", "->"] });
  const arrow = host.expectMappingArrow("item select case");
  const hasArrow = arrow !== "missing";
  let model: ExprNode;
  const atClauseBoundary = host.current().text === "}"
    || host.current().text === ","
    || host.current().text === ";"
    || (arrow === "recoveredUnexpected"
      && host.isLineBoundaryOr()
      && (host.current().text === "case" || host.current().text === "fallback"));
  if (hasArrow && atClauseBoundary) {
    host.addDiagnosticAtCurrent("rsgl.expectedExpression", "Expected model expression after mapping arrow.");
    model = host.missingExprAt(host.current());
  } else if (!hasArrow && (host.isLineBoundaryOr("}") || atClauseBoundary)) {
    model = host.missingExprAt(host.current());
  } else {
    model = host.parseExpression({ stopTexts: [], allowLeadingLineBreak: hasArrow });
  }
  return {
    kind: "ItemSelectCase",
    when,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemConditionStmt(host: ResourceStatementParserHost): ItemConditionStmtNode {
  const start = host.advance();
  const { property, options } = parseItemModelStatementHeader(host, "condition", itemConditionOptionKeywords);
  let onTrue: ExprNode | undefined;
  let onFalse: ExprNode | undefined;

  if (host.matchText("{")) {
    while (!host.isAtEnd() && host.current().text !== "}") {
      const mark = host.mark();
      if (host.current().text === "on_true") {
        host.advance();
        onTrue = host.parseExpression({ stopTexts: [] });
      } else if (host.current().text === "on_false") {
        host.advance();
        onFalse = host.parseExpression({ stopTexts: [] });
      } else {
        host.addDiagnosticAtCurrent("rsgl.unexpectedItemConditionStatement", "Expected 'on_true' or 'on_false' in item condition body.");
        host.recoverToLineEnd();
      }
      host.ensureProgress(mark, "Unable to parse item condition statement; skipping token.");
    }
    host.expectText("}", "Expected '}' after item condition body.");
  } else {
    host.addDiagnosticAtCurrent("rsgl.expectedItemConditionBody", "Expected item condition body.");
  }

  return {
    kind: "ItemConditionStmt",
    keyword: start.text,
    property,
    options,
    onTrue,
    onFalse,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemCompositeStmt(host: ResourceStatementParserHost): ItemCompositeStmtNode {
  const start = host.advance();
  const models: ExprNode[] = [];

  if (host.matchText("{")) {
    while (!host.isAtEnd() && host.current().text !== "}") {
      const mark = host.mark();
      if (host.current().text === "model") {
        host.advance();
        models.push(host.parseExpression({ stopTexts: [] }));
      } else {
        host.addDiagnosticAtCurrent("rsgl.unexpectedItemCompositeStatement", "Expected 'model' in item composite body.");
        host.recoverToLineEnd();
      }
      host.ensureProgress(mark, "Unable to parse item composite statement; skipping token.");
    }
    host.expectText("}", "Expected '}' after item composite body.");
  } else {
    host.addDiagnosticAtCurrent("rsgl.expectedItemCompositeBody", "Expected item composite body.");
  }

  return {
    kind: "ItemCompositeStmt",
    keyword: start.text,
    models,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemEmptyStmt(host: ResourceStatementParserHost): ItemEmptyStmtNode {
  const start = host.advance();
  return {
    kind: "ItemEmptyStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemSelectedItemStmt(host: ResourceStatementParserHost): ItemSelectedItemStmtNode {
  const start = host.advance();
  return {
    kind: "ItemSelectedItemStmt",
    keyword: start.text,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemSpecialStmt(host: ResourceStatementParserHost): ItemSpecialStmtNode {
  const start = host.advance();
  host.expectText("base", "Expected 'base' in item special statement.");
  const base = host.parseExpression({ stopTexts: ["model"] });
  host.expectText("model", "Expected 'model' in item special statement.");
  const model = host.current().text === "{"
    ? host.parseObjectExpression()
    : host.parseExpression({ stopTexts: [] });
  return {
    kind: "ItemSpecialStmt",
    keyword: start.text,
    base,
    model,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseItemModelStatementHeader(
  host: ResourceStatementParserHost,
  owner: "range" | "select" | "condition",
  optionKeywords: readonly string[]
): { property: ExprNode; options: ItemOptionNode[] } {
  host.expectText("property", `Expected 'property' in item ${owner} statement.`);
  const property = host.parseExpression({ stopTexts: [...optionKeywords, "{"] });
  const options: ItemOptionNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "{") {
    const mark = host.mark();
    const start = host.current();
    const name = host.parseIdentifier(`Expected item ${owner} option name.`);
    if (!name) {
      host.recoverToLineEnd();
      host.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
      continue;
    }
    const value = host.parseExpression({ stopTexts: [...optionKeywords, "{"] });
    options.push({
      kind: "ItemOption",
      name,
      value,
      ...host.nodeRanges(start, host.previousOr(start))
    });
    host.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
  }
  return { property, options };
}
