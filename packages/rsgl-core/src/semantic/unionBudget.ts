import type { RsglDiagnostic, TextRange } from "../parser";
import { diagnostic } from "./diagnostics";
import type { RsglUnionBudgetOptions } from "./typeNormalization";
import { formatType } from "./typeRelations";

/** Creates one source-attributed warning reporter for an inferred-union site. */
export function inferredUnionBudgetOptions(
  diagnostics: RsglDiagnostic[],
  range: TextRange
): RsglUnionBudgetOptions {
  return {
    onWiden: widening => {
      if (diagnostics.some(item =>
        item.code === "rsgl.unionWidened"
        && item.range.start === range.start
        && item.range.end === range.end
      )) {
        return;
      }
      diagnostics.push(diagnostic(
        "rsgl.unionWidened",
        `Inferred union has ${widening.armCount} arms, exceeding the ${widening.budget}-arm budget; widened to ${formatType(widening.widenedType)}.`,
        range,
        "warning"
      ));
    }
  };
}
