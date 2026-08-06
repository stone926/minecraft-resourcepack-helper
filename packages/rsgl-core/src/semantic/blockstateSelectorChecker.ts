import type { ExprNode, RsglNode } from "../parser";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import {
  checkBlockstateStateRecord
} from "./blockstateStateRecordChecker";
import type { RsglScope, RsglType } from "./types";

/** Checks a structured variants selector without changing ordinary records. */
export function checkBlockstateSelector(
  context: RsglExpressionCheckContext,
  selector: ExprNode,
  scope: RsglScope
): RsglType {
  return checkBlockstateStateRecord(context, selector, scope, "selector");
}

export type BlockstateSelectorNode = RsglNode;
