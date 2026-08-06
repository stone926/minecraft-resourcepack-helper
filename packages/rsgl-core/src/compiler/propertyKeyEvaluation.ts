import type { ExprNode, PropertyKeyNode } from "../parser";
import { staticPropertyKeyName } from "../parser";
import type { EvaluationContext, EvaluationValue } from "./evaluationTypes";
import { evaluationScalarText } from "./evaluatedResourceValues";

export interface PropertyKeyEvaluationHost {
  evaluateExpression(expression: ExprNode, context: EvaluationContext): EvaluationValue;
}

/** Resolves one shared object/resource key; a computed expression is evaluated exactly once. */
export function evaluatePropertyKey(
  key: PropertyKeyNode,
  context: EvaluationContext,
  host: PropertyKeyEvaluationHost
): string | null {
  const staticName = staticPropertyKeyName(key);
  if (staticName !== undefined) {
    return staticName;
  }
  if (key.kind !== "DynamicKey") {
    return null;
  }
  return evaluationScalarText(host.evaluateExpression(key.expression, context));
}
