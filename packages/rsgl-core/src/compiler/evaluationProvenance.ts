import type {
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationPathRange,
  EvaluationResult
} from "./evaluationTypes";
import type { EvaluationValueIssue } from "./evaluationTypes";
import { joinGeneratedPath } from "./sourcePaths";

/** Returns the most specific provenance at `generatedPath`. */
export function originForEvaluationPath(
  origins: readonly EvaluationPathOrigin[],
  generatedPath: string
): EvaluationOrigin | undefined {
  const origin = mostSpecificPathEntry(origins, generatedPath);
  return origin ? { sourceFile: origin.sourceFile, sourceRange: origin.sourceRange } : undefined;
}

/** Returns the most specific direct syntax range at `generatedPath`. */
export function rangeForEvaluationPath(
  ranges: readonly EvaluationPathRange[],
  generatedPath: string
): EvaluationPathRange["sourceRange"] | undefined {
  return mostSpecificPathEntry(ranges, generatedPath)?.sourceRange;
}

/** Selects a structured value path and rebases it to the result root. */
export function selectEvaluationPathOrigins(
  origins: readonly EvaluationPathOrigin[],
  selectedPath: string
): EvaluationPathOrigin[] {
  const selected = selectPathEntries(origins, selectedPath);
  if (selected.length > 0) {
    return selected;
  }
  const inherited = originForEvaluationPath(origins, selectedPath);
  return inherited ? [{ generatedPath: "", ...inherited }] : [];
}

/** Selects value-shape issues below a JSON pointer and rebases them to the selected value. */
export function selectEvaluationValueIssues(
  issues: readonly EvaluationValueIssue[],
  selectedPath: string
): EvaluationValueIssue[] {
  return selectPathEntries(issues, selectedPath);
}

export function materializeEvaluationValueIssues(
  result: Pick<EvaluationResult, "valueIssues">,
  sourceFile?: string
): EvaluationValueIssue[] {
  return result.valueIssues.map(issue => ({
    ...issue,
    ...(issue.sourceFile || !sourceFile ? {} : { sourceFile })
  }));
}

/**
 * Converts direct syntax ranges to durable origins for a lexical binding.
 * An inherited origin wins at the same path (or an ancestor), so wrapping a
 * caller value in an identifier/conditional never replaces caller provenance
 * with the wrapper's definition range.
 */
export function materializeEvaluationPathOrigins(
  result: Pick<EvaluationResult, "pathOrigins" | "pathRanges">,
  sourceFile?: string
): EvaluationPathOrigin[] {
  const inheritedOrigins = deduplicatePathEntries(result.pathOrigins);
  if (!sourceFile) {
    return inheritedOrigins;
  }
  const origins = [...inheritedOrigins];
  for (const item of result.pathRanges) {
    if (!originForEvaluationPath(inheritedOrigins, item.generatedPath)) {
      origins.push({
        generatedPath: item.generatedPath,
        sourceFile,
        sourceRange: item.sourceRange
      });
    }
  }
  return deduplicatePathEntries(origins);
}

/** @internal Shared by the trace builder without exposing evaluator state. */
export function selectPathEntries<T extends { generatedPath: string }>(
  entries: readonly T[],
  selectedPath: string
): T[] {
  return entries
    .filter(item => item.generatedPath === selectedPath || item.generatedPath.startsWith(`${selectedPath}/`))
    .map(item => ({
      ...item,
      generatedPath: item.generatedPath.slice(selectedPath.length)
    }));
}

/** @internal Retains the last observation for each generated path. */
export function deduplicatePathEntries<T extends { generatedPath: string }>(
  entries: readonly T[]
): T[] {
  const byPath = new Map<string, T>();
  for (const entry of entries) {
    byPath.set(entry.generatedPath, entry);
  }
  return [...byPath.values()];
}

/** @internal Deduplicates identical value-shape observations. */
export function deduplicateValueIssues(
  issues: readonly EvaluationValueIssue[]
): EvaluationValueIssue[] {
  const byIdentity = new Map<string, EvaluationValueIssue>();
  for (const issue of issues) {
    byIdentity.set(JSON.stringify([
      issue.generatedPath,
      issue.kind,
      issue.sourceFile ?? "",
      issue.sourceRange.start,
      issue.sourceRange.end
    ]), issue);
  }
  return [...byIdentity.values()];
}

function mostSpecificPathEntry<T extends { generatedPath: string }>(
  entries: readonly T[],
  generatedPath: string
): T | undefined {
  return entries
    .filter(item => item.generatedPath === generatedPath || (
      item.generatedPath === "" || generatedPath.startsWith(`${item.generatedPath}/`)
    ))
    .sort((left, right) => right.generatedPath.length - left.generatedPath.length)[0];
}

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
