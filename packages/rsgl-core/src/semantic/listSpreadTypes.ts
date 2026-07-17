import type { RsglNode } from "../parser";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { combineRsglTypes } from "./typeNormalization";
import { formatType } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import { neverType, unknownType, type RsglType } from "./types";

/** Resolves the element type contributed by a list spread expression. */
export function resolveListSpreadElementType(
  context: RsglExpressionCheckContext,
  spreadType: RsglType,
  spread: RsglNode
): RsglType | undefined {
  if (spreadType.kind === "List") {
    return spreadType.elementType ?? unknownType;
  }
  if (spreadType.kind === "Union") {
    const options = spreadType.options ?? [];
    if (options.every(option =>
      option.kind === "List"
      || option.kind === "Unknown"
      || option.kind === "Any"
      || option.kind === "Never"
    )) {
      const elementTypes = options.flatMap(option => {
        if (option.kind === "List") {
          return [option.elementType ?? unknownType];
        }
        if (option.kind === "Never") {
          return [];
        }
        return [option];
      });
      return combineRsglTypes(
        elementTypes.length > 0 ? elementTypes : [neverType],
        false,
        inferredUnionBudgetOptions(context.diagnostics, spread.range)
      );
    }
  }
  if (spreadType.kind === "Unknown" || spreadType.kind === "Any") {
    return spreadType;
  }
  context.diagnostics.push(diagnostic(
    "rsgl.invalidListSpread",
    `List spread requires a List value, got ${formatType(spreadType)}.`,
    spread.range
  ));
  return undefined;
}
