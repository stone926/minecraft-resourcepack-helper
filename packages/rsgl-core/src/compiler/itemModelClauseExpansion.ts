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
  forEachBodyStatement,
  type RsglBodyEntryStatement
} from "../bodyStatementDispatch";
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

type ItemOwnerBody =
  | ItemSelectBodyNode
  | ItemRangeBodyNode
  | ItemCompositeBodyNode
  | ItemFirstMatchBodyNode
  | ItemModelTemplateBodyNode;

type ItemOwnerStatement = ItemOwnerBody["statements"][number];

interface ItemBodyExpansionContext {
  readonly context: RsglCompileContext;
  readonly host: ItemModelClauseExpansionHost;
  readonly expectedKind: ItemOwnerBody["kind"];
  readonly expectedDescription: string;
  readonly generatedPath: string;
  readonly visitBody: (
    body: RsglStatementBodyNode,
    context: RsglCompileContext
  ) => void;
}

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
  expandItemBodyStatements(body.statements, {
    context,
    host,
    expectedKind: "ItemSelectBody",
    expectedDescription: "ItemSelectBody",
    generatedPath,
    visitBody: (nested, nestedContext) =>
      expandItemSelectBody(nested as ItemSelectBodyNode, nestedContext, host, visit, generatedPath)
  }, visit);
}

/** Expands entry/frames/fallback clauses in a range body in source order. */
export function expandItemRangeBody(
  body: ItemRangeBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemRangeClause, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  expandItemBodyStatements(body.statements, {
    context,
    host,
    expectedKind: "ItemRangeBody",
    expectedDescription: "ItemRangeBody",
    generatedPath,
    visitBody: (nested, nestedContext) =>
      expandItemRangeBody(nested as ItemRangeBodyNode, nestedContext, host, visit, generatedPath)
  }, visit);
}

/** Expands model clauses in a composite body in source order. */
export function expandItemCompositeBody(
  body: ItemCompositeBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  visit: (statement: ItemCompositeClause, context: RsglCompileContext) => void,
  generatedPath = "/model"
): void {
  expandItemBodyStatements(body.statements, {
    context,
    host,
    expectedKind: "ItemCompositeBody",
    expectedDescription: "ItemCompositeBody",
    generatedPath,
    visitBody: (nested, nestedContext) =>
      expandItemCompositeBody(
        nested as ItemCompositeBodyNode,
        nestedContext,
        host,
        visit,
        generatedPath
      )
  }, visit);
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
  expandItemBodyStatements(body.statements, {
    context,
    host,
    expectedKind: "ItemModelTemplateBody",
    expectedDescription: "item_model template",
    generatedPath,
    visitBody: (nested, nestedContext) =>
      expandItemModelTemplateBody(
        nested as ItemModelTemplateBodyNode,
        nestedContext,
        host,
        visit,
        generatedPath
      )
  }, visit);
}

function collectFirstMatchBody(
  body: ItemFirstMatchBodyNode,
  context: RsglCompileContext,
  host: ItemModelClauseExpansionHost,
  result: ExpandedItemFirstMatchClauses,
  generatedPath: string
): void {
  expandItemBodyStatements(body.statements, {
    context,
    host,
    expectedKind: "ItemFirstMatchBody",
    expectedDescription: "ItemFirstMatchBody",
    generatedPath,
    visitBody: (nested, nestedContext) =>
      collectFirstMatchBody(
        nested as ItemFirstMatchBodyNode,
        nestedContext,
        host,
        result,
        generatedPath
      )
  }, (statement, entryContext) => {
    switch (statement.kind) {
      case "ItemFirstMatchWhen":
        result.whens.push({ node: statement, context: childEvaluationContext(entryContext, {}) });
        break;
      case "ItemFallbackClause":
        result.fallbacks.push({ node: statement, context: childEvaluationContext(entryContext, {}) });
        break;
      default:
        assertNever(statement);
    }
  });
}

function expandItemBodyStatements<TStatement extends ItemOwnerStatement>(
  statements: readonly TStatement[],
  expansion: ItemBodyExpansionContext,
  onEntry: (
    statement: RsglBodyEntryStatement<TStatement>,
    context: RsglCompileContext
  ) => void
): void {
  forEachBodyStatement(statements, {
    context: expansion,
    onEntry: (statement, current) => onEntry(statement, current.context),
    onLet: (statement, current) => bindLet(statement, current.context),
    onFor: (statement, current) => executeOwnerFor(
      statement,
      current.context,
      current.host,
      current.expectedKind,
      current.visitBody,
      current.expectedDescription,
      current.generatedPath
    ),
    onIf: (statement, current) => executeOwnerIf(
      statement,
      current.context,
      current.host,
      current.expectedKind,
      current.visitBody,
      current.expectedDescription
    )
  });
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
