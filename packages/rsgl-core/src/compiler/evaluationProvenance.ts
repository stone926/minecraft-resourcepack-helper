import type {
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationResult
} from "./evaluate";
import { originForEvaluationPath } from "./evaluate";
import { joinGeneratedPath } from "./sourcePaths";

/**
 * Rebases inherited provenance recorded by one evaluator run to the JSON path
 * owned by a compiler sink.
 *
 * Direct `pathRanges` intentionally stay in the public source map produced by
 * the sink. Promoting them to validation origins would make an ordinary local
 * object literal override the DSL statement/entry range chosen by that sink.
 * Collection operations and lexical bindings already materialize the source
 * values they propagate into `pathOrigins`, so exact element provenance is
 * retained without re-evaluating the AST.
 */
export function evaluatedPathOrigins(
  result: Pick<EvaluationResult, "pathOrigins">,
  generatedPath = ""
): EvaluationPathOrigin[] {
  return result.pathOrigins.map(origin => ({
    ...origin,
    generatedPath: joinGeneratedPath(generatedPath, origin.generatedPath)
  }));
}

/** Returns the most specific root provenance from the same evaluator run. */
export function evaluatedRootOrigin(
  result: Pick<EvaluationResult, "origin" | "pathOrigins">
): EvaluationOrigin | undefined {
  return evaluatedOriginAtPath(result, "") ?? result.origin;
}

/** Returns the most specific provenance for one path from the same run. */
export function evaluatedOriginAtPath(
  result: Pick<EvaluationResult, "pathOrigins">,
  generatedPath: string
): EvaluationOrigin | undefined {
  return originForEvaluationPath(result.pathOrigins, generatedPath);
}
