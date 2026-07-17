import { EvaluationItemBudget } from "./evaluationItemBudget";
import type { EvaluationContext } from "./evaluationTypes";

/** Returns the shared mutable item budget for one evaluation pipeline. */
export function evaluationItemBudget(context: EvaluationContext): EvaluationItemBudget {
  context.evaluationItemBudget ??= new EvaluationItemBudget();
  return context.evaluationItemBudget;
}
