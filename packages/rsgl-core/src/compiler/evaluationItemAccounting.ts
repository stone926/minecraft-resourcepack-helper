import type { TextRange } from "../parser";
import { EvaluationItemBudget } from "./evaluationItemBudget";

interface EvaluationItemAccountingContext {
  evaluationItemBudget?: EvaluationItemBudget;
  onEvaluationFailure?: () => void;
  onError?: (
    code: string,
    message: string,
    range: TextRange,
    fileName?: string
  ) => void;
  sourceFile?: string;
}

type EvaluationItemErrorReporter = (
  code: string,
  message: string,
  range: TextRange,
  fileName?: string
) => void;

/** Accounts one collection-producing operation against the shared compile budget. */
export function consumeEvaluationItems(
  context: EvaluationItemAccountingContext,
  count: number,
  range: TextRange,
  operation: string,
  reportError: EvaluationItemErrorReporter | undefined = context.onError
): boolean {
  const budget = context.evaluationItemBudget ??= new EvaluationItemBudget();
  if (budget.tryConsume(count)) {
    return true;
  }
  context.onEvaluationFailure?.();
  reportError?.(
    "rsgl.collectionExpansionLimit",
    `Collection operation '${operation}' exceeds maxEvaluationItems=${budget.limit} `
      + `(consumed ${budget.consumed}, requested ${Number.isSafeInteger(count) ? count : `more than ${budget.remaining}`}).`,
    range,
    context.sourceFile
  );
  return false;
}

/**
 * Makes a finite expansion cost at least one budget item per emitted element.
 *
 * Evaluating ranges, maps, or spreads may already account for all or part of
 * the iterable. Literal lists do not allocate through those operations, so the
 * remaining element count is charged here without double-counting the former.
 */
export function ensureEvaluationItemsForExpansion(
  context: EvaluationItemAccountingContext,
  consumedBeforeEvaluation: number,
  expansionCount: number,
  range: TextRange,
  operation: string,
  reportError: EvaluationItemErrorReporter | undefined = context.onError
): boolean {
  const budget = context.evaluationItemBudget ??= new EvaluationItemBudget();
  const consumedWhileEvaluating = Math.max(0, budget.consumed - consumedBeforeEvaluation);
  const remainingCost = Number.isSafeInteger(expansionCount)
    ? Math.max(0, expansionCount - consumedWhileEvaluating)
    : Number.POSITIVE_INFINITY;
  return consumeEvaluationItems(context, remainingCost, range, operation, reportError);
}
