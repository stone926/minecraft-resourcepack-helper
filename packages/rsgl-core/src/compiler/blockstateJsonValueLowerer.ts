import type { TextRange } from "../parser";
import {
  type EvaluationResult,
  rangeForEvaluationPath
} from "./evaluate";
import type { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

export interface BlockstateJsonValueLoweringHost {
  onError: (code: string, message: string, range: TextRange, fileName?: string) => void;
}

/**
 * Clones an evaluated value only after proving recursive JSON serializability.
 * Evaluation trace issues retain invalid children that the legacy evaluator
 * represents as null, so blockstate Json escape values can never hide lambdas,
 * undefined values, or lossy computed object keys behind normalization.
 */
export function lowerSerializableBlockstateJsonValue(
  result: EvaluationResult,
  fallbackRange: TextRange,
  host: BlockstateJsonValueLoweringHost
): JsonValue | undefined {
  const issue = result.valueIssues.find(item =>
    item.kind === "duplicateObjectKey" || item.kind === "invalidObjectKey"
  ) ?? result.valueIssues[0];
  if (issue) {
    reportUnserializable(
      describeValueIssue(issue.kind),
      issue.generatedPath,
      issue.sourceRange,
      host,
      issue.sourceFile
    );
    return undefined;
  }
  return cloneSerializableValue(
    result.value,
    "",
    fallbackRange,
    result,
    host,
    new Set<object>()
  );
}

function describeValueIssue(kind: EvaluationResult["valueIssues"][number]["kind"]): string {
  if (kind === "duplicateObjectKey") {
    return "duplicate computed object key";
  }
  if (kind === "invalidObjectKey") {
    return "computed object key without a value";
  }
  return kind;
}

function cloneSerializableValue(
  value: unknown,
  generatedPath: string,
  fallbackRange: TextRange,
  result: EvaluationResult,
  host: BlockstateJsonValueLoweringHost,
  ancestors: Set<object>
): JsonValue | undefined {
  const range = rangeForEvaluationPath(result.pathRanges, generatedPath) ?? fallbackRange;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    reportUnserializable("nonFiniteNumber", generatedPath, range, host);
    return undefined;
  }
  if (value === undefined) {
    reportUnserializable("undefined", generatedPath, range, host);
    return undefined;
  }
  if (!Array.isArray(value) && !isJsonObject(value)) {
    reportUnserializable("runtime object", generatedPath, range, host);
    return undefined;
  }
  if (ancestors.has(value)) {
    reportUnserializable("cyclic object", generatedPath, range, host);
    return undefined;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    const cloned: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const child = cloneSerializableValue(
        item,
        appendGeneratedPath(generatedPath, String(index)),
        fallbackRange,
        result,
        host,
        ancestors
      );
      if (child === undefined) {
        ancestors.delete(value);
        return undefined;
      }
      cloned.push(child);
    }
    ancestors.delete(value);
    return cloned;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    ancestors.delete(value);
    reportUnserializable("runtime object", generatedPath, range, host);
    return undefined;
  }
  const cloned: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = cloneSerializableValue(
      item,
      appendGeneratedPath(generatedPath, key),
      fallbackRange,
      result,
      host,
      ancestors
    );
    if (child === undefined) {
      ancestors.delete(value);
      return undefined;
    }
    cloned[key] = child;
  }
  ancestors.delete(value);
  return cloned;
}

function reportUnserializable(
  kind: string,
  generatedPath: string,
  range: TextRange,
  host: BlockstateJsonValueLoweringHost,
  sourceFile?: string
): void {
  const location = generatedPath || "<root>";
  host.onError(
    "rsgl.unserializableBlockstateJsonValue",
    `Blockstate model value at '${location}' is not JSON-serializable (${kind}).`,
    range,
    sourceFile
  );
}
