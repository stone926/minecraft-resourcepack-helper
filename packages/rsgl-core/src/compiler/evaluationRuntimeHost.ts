import type { ExprNode, TextRange } from "../parser";
import type {
  EvaluationContext,
  EvaluationResult,
  EvaluationValue
} from "./evaluationTypes";

/** A fully evaluated call argument plus the trace captured at its source site. */
export interface EvaluationCallArgument {
  name?: string;
  value: EvaluationValue;
  range: TextRange;
  result?: EvaluationResult;
  sourceFile?: string;
}

/**
 * Recursive evaluator operations supplied by the composition root.
 *
 * Feature evaluators depend on this narrow interface instead of importing
 * evaluate.ts, keeping recursion explicit and the runtime dependency graph
 * acyclic.
 */
export interface EvaluationRuntimeHost {
  evaluateExpression(expression: ExprNode, context: EvaluationContext): EvaluationValue;
  childEvaluationContext(
    context: EvaluationContext,
    values: Record<string, EvaluationValue>,
    metadata?: Partial<Pick<
      EvaluationContext,
      "sourceFile" | "mappingReason" | "expansionStack" | "onError"
    >>
  ): EvaluationContext;
}
