import type { ExprNode } from "../parser";
import { checkBlockstatePredicate } from "./expressionChecker";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { checkBlockstateStateRecord } from "./blockstateStateRecordChecker";
import type { RsglScope, RsglType } from "./types";

/**
 * Multipart keeps the first-class StatePredicate language while reserving an
 * inline object expression for the typed equality-record shorthand.
 */
export function checkBlockstateMultipartCondition(
  context: RsglExpressionCheckContext,
  expression: ExprNode,
  scope: RsglScope
): RsglType {
  return expression.kind === "ObjectExpr"
    ? checkBlockstateStateRecord(context, expression, scope, "multipart")
    : checkBlockstatePredicate(context, expression, scope);
}
