import type { JsonValue } from "./ir";

/**
 * Converts evaluator-only values to the JSON value expected by lowerers.
 *
 * This lives below both the evaluator and compiler helpers so collection
 * builtins can normalize values without creating a runtime dependency cycle.
 */
export function normalizeJsonValue(value: unknown): JsonValue {
  if (value === undefined || isLambdaLikeValue(value)) {
    return null;
  }
  return value as JsonValue;
}

export function isLambdaLikeValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    kind?: string;
    parameters?: unknown;
    body?: unknown;
    context?: unknown;
    impureCalls?: unknown;
  };
  return candidate.kind === "lambda"
    && Array.isArray(candidate.parameters)
    && Boolean(candidate.body && typeof candidate.body === "object")
    && Boolean(candidate.context && typeof candidate.context === "object")
    && Array.isArray(candidate.impureCalls);
}
