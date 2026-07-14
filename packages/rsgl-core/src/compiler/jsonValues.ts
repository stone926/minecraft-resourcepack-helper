import type { JsonValue } from "./ir";
import { isEvaluatedResourceValue } from "./evaluatedResourceValues";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { appendGeneratedPath } from "./sourcePaths";

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || isEvaluatedResourceValue(value)
    || isLambdaRuntimeValue(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  const prototype = Object.getPrototypeOf(value) === null ? null : Object.prototype;
  const result = createJsonObject(prototype);
  for (const [key, item] of jsonObjectEntries(value)) {
    setJsonObjectProperty(result, key, cloneJsonValue(item));
  }
  return result;
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
    jsonObjectEntries(value).forEach(([key, item]) => visitJsonWithPath(item, visitor, appendGeneratedPath(generatedPath, key)));
  }
}
