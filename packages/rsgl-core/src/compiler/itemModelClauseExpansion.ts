import type {
  ExprNode,
  ForStmtNode,
  IfStmtNode,
  ItemCompositeBodyNode,
  ItemFallbackClauseNode,
  ItemFirstMatchBodyNode,
  ItemFirstMatchWhenNode,
  ItemModelTemplateBodyNode,
  ItemRangeBodyNode,
  ItemSelectBodyNode,
  RsglStatementBodyNode,
  TextRange
} from "../parser";
import {
  bindEvaluationResult,
  childEvaluationContext,
  evaluateCompileTimeCondition,
  evaluateExpressionResult
} from "./evaluate";
import { forEachLoopContext } from "./looping";
import type { RsglCompileContext } from "./templateExpansion";

/** Narrow compiler seam used while expanding typed item-model bodies. */
export interface ItemModelClauseExpansionHost {
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
}

export interface CapturedItemModelClause<T> {
  readonly node: T;
  readonly context: RsglCompileContext;
}

export interface ExpandedItemFirstMatchClauses {
  readonly whens: CapturedItemModelClause<ItemFirstMatchWhenNode>[];
  readonly fallbacks: CapturedItemModelClause<ItemFallbackClauseNode>[];
}

type ItemSelectClause = Extract<
  ItemSelectBodyNode["statements"][number],
  { kind: "ItemSelectCase" | "ItemFallbackClause" }
>;

type ItemRangeClause = Extract<
  ItemRangeBodyNode["statements"][number],
  { kind: "ItemRangeEntry" | "ItemRangeFrames" | "ItemFallbackClause" }
>;

type ItemCompositeClause = Extract<
  ItemCompositeBodyNode["statements"][number],
  { kind: "ItemCompositeModel" }
>;

export type ItemModelTemplateExecutableStatement = Extract<
  ItemModelTemplateBodyNode["statements"][number],
  { kind: "ItemModelProducerStmt" | "UseDecl" }
>;

/** Expands the finite control flow in a select body in source order. */
export function expandItemSelectBody(
  body: ItemSelectBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemSelectClause, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  for (const statement of body.statements) {
    switch (statement.kind) {
      case "ItemSelectCase":
      case "ItemFallbackClause":
        visit(statement, context);
        break;
      case "LetDecl":
        bindLet(statement, context);
        break;
      case "ForStmt":
        executeOwnerFor(statement, context, host, "ItemSelectBody", (nested, nestedContext) =>
          expandItemSelectBody(nested as ItemSelectBodyNode, nestedContext, host, visit, generatedPath),
        "ItemSelectBody", generatedPath);
        break;
      case "IfStmt":
        executeOwnerIf(statement, context, host, "ItemSelectBody", (nested, nestedContext) =>
          expandItemSelectBody(nested as ItemSelectBodyNode, nestedContext, host, visit, generatedPath));
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }
}

/** Expands entry/frames/fallback clauses in a range body in source order. */
export function expandItemRangeBody(
  body: ItemRangeBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemRangeClause, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  for (const statement of body.statements) {
    switch (statement.kind) {
      case "ItemRangeEntry":
      case "ItemRangeFrames":
      case "ItemFallbackClause":
        visit(statement, context);
        break;
      case "LetDecl":
        bindLet(statement, context);
        break;
      case "ForStmt":
        executeOwnerFor(statement, context, host, "ItemRangeBody", (nested, nestedContext) =>
          expandItemRangeBody(nested as ItemRangeBodyNode, nestedContext, host, visit, generatedPath),
        "ItemRangeBody", generatedPath);
        break;
      case "IfStmt":
        executeOwnerIf(statement, context, host, "ItemRangeBody", (nested, nestedContext) =>
          expandItemRangeBody(nested as ItemRangeBodyNode, nestedContext, host, visit, generatedPath));
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }
}

/** Expands model clauses in a composite body in source order. */
export function expandItemCompositeBody(
  body: ItemCompositeBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemCompositeClause, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  for (const statement of body.statements) {
    switch (statement.kind) {
      case "ItemCompositeModel":
        visit(statement, context);
        break;
      case "LetDecl":
        bindLet(statement, context);
        break;
      case "ForStmt":
        executeOwnerFor(statement, context, host, "ItemCompositeBody", (nested, nestedContext) =>
          expandItemCompositeBody(nested as ItemCompositeBodyNode, nestedContext, host, visit, generatedPath),
        "ItemCompositeBody", generatedPath);
        break;
      case "IfStmt":
        executeOwnerIf(statement, context, host, "ItemCompositeBody", (nested, nestedContext) =>
          expandItemCompositeBody(nested as ItemCompositeBodyNode, nestedContext, host, visit, generatedPath));
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }
}

/**
 * Expands and captures an ordered first_match body. Each captured context is a
 * snapshot so later sibling lets cannot affect a clause that appeared earlier.
 */
export function collectItemFirstMatchClauses(
  body: ItemFirstMatchBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  generatedPath = "/model"
): ExpandedItemFirstMatchClauses {
  const result: ExpandedItemFirstMatchClauses = { whens: [], fallbacks: [] };
  collectFirstMatchBody(body, context, host, result, generatedPath);
  return result;
}

/** Executes finite control flow in an item_model template body in source order. */
export function expandItemModelTemplateBody(
  body: ItemModelTemplateBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemModelTemplateExecutableStatement, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  for (const statement of body.statements) {
    switch (statement.kind) {
      case "ItemModelProducerStmt":
      case "UseDecl":
        visit(statement, context);
        break;
      case "LetDecl":
        bindLet(statement, context);
        break;
      case "ForStmt":
        executeOwnerFor(
          statement,
          context,
          host,
          "ItemModelTemplateBody",
          (nested, nestedContext) =>
            expandItemModelTemplateBody(nested as ItemModelTemplateBodyNode, nestedContext, host, visit, generatedPath),
          "item_model template",
          generatedPath
        );
        break;
      case "IfStmt":
        executeOwnerIf(
          statement,
          context,
          host,
          "ItemModelTemplateBody",
          (nested, nestedContext) =>
            expandItemModelTemplateBody(nested as ItemModelTemplateBodyNode, nestedContext, host, visit, generatedPath),
          "item_model template"
        );
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }
}

function collectFirstMatchBody(
  body: ItemFirstMatchBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  result: ExpandedItemFirstMatchClauses,
  generatedPath: string
): void {
  for (const statement of body.statements) {
    switch (statement.kind) {
      case "ItemFirstMatchWhen":
        result.whens.push({ node: statement, context: childEvaluationContext(context, {}) });
        break;
      case "ItemFallbackClause":
        result.fallbacks.push({ node: statement, context: childEvaluationContext(context, {}) });
        break;
      case "LetDecl":
        bindLet(statement, context);
        break;
      case "ForStmt":
        executeOwnerFor(statement, context, host, "ItemFirstMatchBody", (nested, nestedContext) =>
          collectFirstMatchBody(nested as ItemFirstMatchBodyNode, nestedContext, host, result, generatedPath),
        "ItemFirstMatchBody", generatedPath);
        break;
      case "IfStmt":
        executeOwnerIf(statement, context, host, "ItemFirstMatchBody", (nested, nestedContext) =>
          collectFirstMatchBody(nested as ItemFirstMatchBodyNode, nestedContext, host, result, generatedPath));
        break;
      case "UnknownStmt":
        break;
      default:
        assertNever(statement);
    }
  }
}

function executeOwnerFor(
  statement: ForStmtNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  expectedKind: string,
  visit: (body: RsglStatementBodyNode, context: RsglCompileContext) => void,
  expectedDescription = expectedKind,
  generatedPath = "/model"
): void {
  forEachLoopContext(
    statement,
    context,
    (code, message, range) => host.onError?.(code, message, range, context.sourceFile),
    loopContext => {
      if (statement.body.kind !== expectedKind) {
        reportItemModelBodyMismatch(host, statement.body.range, context, expectedDescription);
        return;
      }
      visit(statement.body, loopContext);
    },
    { operation: `for expansion at item-model node '${generatedPath}'` }
  );
}

function executeOwnerIf(
  statement: IfStmtNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  expectedKind: string,
  visit: (body: RsglStatementBodyNode, context: RsglCompileContext) => void,
  expectedDescription = expectedKind
): void {
  const selected = selectedControlBody(statement, context);
  if (!selected) {
    return;
  }
  if (selected.kind !== expectedKind) {
    reportItemModelBodyMismatch(host, selected.range, context, expectedDescription);
    return;
  }
  visit(selected, childEvaluationContext(context, {}));
}

function selectedControlBody(
  statement: IfStmtNode,
  context: RsglCompileContext
): RsglStatementBodyNode | undefined {
  const condition = evaluateCompileTimeCondition(statement.condition, context);
  return condition === undefined ? undefined : condition ? statement.thenBody : statement.elseBody;
}

function bindLet(
  statement: { name: { text: string } | null; value: ExprNode },
  context: RsglCompileContext
): void {
  if (statement.name) {
    bindEvaluationResult(context, statement.name.text, evaluateExpressionResult(statement.value, context));
  }
}

export function reportItemModelBodyMismatch(
  host: ItemModelClauseExpansionHost,
  range: TextRange,
  context: RsglCompileContext,
  expected: string
): void {
  host.onError?.(
    "rsgl.itemModelBodyBoundaryMismatch",
    `Expected ${expected} statements at this item-model boundary.`,
    range,
    context.sourceFile
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled item-model body statement: ${JSON.stringify(value)}`);
}
