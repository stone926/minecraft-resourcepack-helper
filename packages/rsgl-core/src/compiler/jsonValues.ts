import type { JsonValue } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLambdaRuntimeValue(value)
  );
}

function isLambdaRuntimeValue(value: object): boolean {
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

export function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)])
  );
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isJsonObject(value)) {
    return cloneJsonObject(value);
  }
  return value;
}

export function visitJsonWithPath(
  value: JsonValue,
  visitor: (value: JsonValue, generatedPath: string) => void,
  generatedPath = ""
): void {
  visitor(value, generatedPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitJsonWithPath(item, visitor, appendGeneratedPath(generatedPath, String(index))));
  } else if (isJsonObject(value)) {
    Object.entries(value).forEach(([key, item]) => visitJsonWithPath(item, visitor, appendGeneratedPath(generatedPath, key)));
  }
}
