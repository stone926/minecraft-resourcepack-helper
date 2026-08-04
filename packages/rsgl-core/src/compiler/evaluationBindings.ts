import type {
  EvaluationContext,
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationResult,
  EvaluationValue,
  EvaluationValueIssue
} from "./evaluationTypes";
import {
  materializeEvaluationPathOrigins,
  materializeEvaluationSelectionPathOrigins,
  materializeEvaluationValueIssues,
  originForEvaluationPath
} from "./evaluationProvenance";

/** Binds a value and its lexical origin without mutating a parent context's origin map. */
export function bindEvaluationValue(
  context: EvaluationContext,
  name: string,
  value: EvaluationValue,
  origin?: EvaluationOrigin,
  pathOrigins: readonly EvaluationPathOrigin[] = [],
  selectionPathOrigins: readonly EvaluationPathOrigin[] = [],
  valueIssues: readonly EvaluationValueIssue[] = []
): void {
  context.variables.set(name, value);
  context.valueBindingNames = new Set([...(context.valueBindingNames ?? []), name]);
  const origins = new Map(context.valueOrigins ?? []);
  if (origin) {
    origins.set(name, origin);
  } else {
    origins.delete(name);
  }
  context.valueOrigins = origins;
  const originsByName = new Map(context.valuePathOrigins ?? []);
  if (pathOrigins.length > 0) {
    originsByName.set(name, [...pathOrigins]);
  } else {
    originsByName.delete(name);
  }
  context.valuePathOrigins = originsByName;
  const selectionsByName = new Map(context.valueSelectionPathOrigins ?? []);
  if (selectionPathOrigins.length > 0) {
    selectionsByName.set(name, [...selectionPathOrigins]);
  } else {
    selectionsByName.delete(name);
  }
  context.valueSelectionPathOrigins = selectionsByName;
  const issuesByName = new Map(context.valueIssues ?? []);
  if (valueIssues.length > 0) {
    issuesByName.set(name, [...valueIssues]);
  } else {
    issuesByName.delete(name);
  }
  context.valueIssues = issuesByName;
}

/** Binds a traced result, materializing direct ranges in the binding's file. */
export function bindEvaluationResult(
  context: EvaluationContext,
  name: string,
  result: EvaluationResult,
  sourceFile = context.sourceFile
): void {
  const pathOrigins = materializeEvaluationPathOrigins(result, sourceFile);
  const selectionPathOrigins = materializeEvaluationSelectionPathOrigins(result, sourceFile);
  bindEvaluationValue(
    context,
    name,
    result.value,
    originForEvaluationPath(pathOrigins, "") ?? result.origin,
    pathOrigins,
    selectionPathOrigins,
    materializeEvaluationValueIssues(result, sourceFile)
  );
}

/** True when a value binding shadows a same-named template or builtin helper. */
export function hasEvaluationValueBinding(
  context: EvaluationContext,
  name: string
): boolean {
  return context.variables.has(name) || Boolean(context.valueBindingNames?.has(name));
}
