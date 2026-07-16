import type { ObjectPropertyNode } from "../parser";
import type { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";

/**
 * Canonicalizes any evaluated item-model value at the compiler boundary.
 * ModelId strings become explicit minecraft:model nodes, while raw objects
 * remain available for schema-validated escape hatches.
 */
export function normalizeItemModelValue(
  value: JsonValue,
  namespace: string
): Record<string, JsonValue> | undefined {
  if (typeof value === "string") {
    return { type: "minecraft:model", model: normalizeModelId(value, namespace) };
  }
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (typeof value.model === "string" && !("type" in value)) {
    return {
      ...value,
      type: "minecraft:model",
      model: normalizeModelId(value.model, namespace)
    };
  }
  return value;
}

export function normalizeModelId(value: string, namespace: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `item/${value}`}`;
}

export function staticObjectKey(key: ObjectPropertyNode["key"]): string | undefined {
  if (key.kind === "Identifier") {
    return key.text;
  }
  if (key.kind === "StringLiteral") {
    return key.value;
  }
  if (key.kind === "NumberLiteral") {
    return String(key.value);
  }
  return undefined;
}

/** Stable structural key used only for duplicate/unreachable diagnostics. */
export function stableJsonKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonKey).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
