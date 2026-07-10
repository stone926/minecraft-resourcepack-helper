import type { JsonValue } from "./ir";

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: string }).kind !== "lambda"
  );
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
