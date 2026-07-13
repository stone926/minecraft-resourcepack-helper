import type { ExprNode } from "../parser";
import { combineRsglTypes, rsglTypeKey } from "./typeNormalization";
import { isAssignable } from "./typeRelations";
import type { RsglType } from "./types";

/**
 * Records the resolved contextual type of an expression without discarding a
 * more precise fact produced by a later (for example, post-link) pass.
 */
export function mergeResolvedExpectedTypeFact(
  facts: Map<ExprNode, RsglType>,
  expression: ExprNode,
  expectedType: RsglType
): void {
  if (expectedType.kind === "Unknown") {
    return;
  }
  const existing = facts.get(expression);
  if (!existing || rsglTypeKey(existing) === rsglTypeKey(expectedType)) {
    facts.set(expression, expectedType);
    return;
  }

  const existingAcceptsIncoming = isAssignable(existing, expectedType);
  const incomingAcceptsExisting = isAssignable(expectedType, existing);
  if (existingAcceptsIncoming && !incomingAcceptsExisting) {
    facts.set(expression, expectedType);
    return;
  }
  if (incomingAcceptsExisting && !existingAcceptsIncoming) {
    return;
  }
  facts.set(expression, combineRsglTypes([existing, expectedType], true));
}
