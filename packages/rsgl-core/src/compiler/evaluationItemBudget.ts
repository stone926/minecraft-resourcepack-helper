import { DEFAULT_MAX_EVALUATION_ITEMS } from "./compileConfiguration";

/** Prevents a permissive project setting from reaching JS Array/OOM limits. */
export const MAX_EVALUATION_ITEMS_PER_ALLOCATION = 10_000_000;

/**
 * Shared mutable accounting for collection-producing compile-time evaluation.
 *
 * A budget belongs to one compile pipeline run. Child evaluation contexts keep
 * the same instance so imported values, templates, and lambda calls cannot each
 * reset the configured expansion limit.
 */
export class EvaluationItemBudget {
  public readonly limit: number;
  private consumedItems = 0;

  public constructor(limit = DEFAULT_MAX_EVALUATION_ITEMS) {
    this.limit = normalizeEvaluationItemLimit(limit);
  }

  public get consumed(): number {
    return this.consumedItems;
  }

  public get remaining(): number {
    return this.limit - this.consumedItems;
  }

  /** Checks an allocation without mutating the shared accounting. */
  public canConsume(count: number): boolean {
    return isEvaluationItemCount(count)
      && count <= MAX_EVALUATION_ITEMS_PER_ALLOCATION
      && count <= this.remaining;
  }

  /**
   * Atomically accounts for an allocation. Callers must invoke this before
   * allocating or appending the corresponding output collection.
   */
  public tryConsume(count: number): boolean {
    if (!this.canConsume(count)) {
      return false;
    }
    this.consumedItems += count;
    return true;
  }
}

function normalizeEvaluationItemLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return DEFAULT_MAX_EVALUATION_ITEMS;
  }
  return limit;
}

function isEvaluationItemCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}
