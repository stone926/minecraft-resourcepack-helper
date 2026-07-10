import type { JsonValue } from "./ir";

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: string }).kind !== "lambda"
  );
}
