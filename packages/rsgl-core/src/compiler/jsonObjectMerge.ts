import { TextRange } from "../parser";
import { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

export { isJsonObject } from "./jsonValues";

export interface JsonObjectMergeOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
  path?: string;
  range: TextRange;
}

export function mergeJsonObject(target: Record<string, JsonValue>, source: Record<string, JsonValue>): Record<string, JsonValue> {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
  return source;
}

export function mergeJsonObjectDeep(target: Record<string, JsonValue>, source: Record<string, JsonValue>): Record<string, JsonValue> {
  const applied: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
      applied[key] = value;
    } else if (isJsonObject(existing) && isJsonObject(value)) {
      const nested = mergeJsonObjectDeep(existing, value);
      if (Object.keys(nested).length > 0) {
        applied[key] = nested;
      }
    } else {
      target[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}

export function overrideJsonObject(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  create: boolean,
  options: JsonObjectMergeOptions
): Record<string, JsonValue> {
  const applied: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const keyPath = appendGeneratedPath(options.path ?? "", key);
    if (existing === undefined) {
      if (!create) {
        options.onError?.("rsgl.overrideMissingField", `override cannot create missing field '${keyPath}' without 'create'.`, options.range);
        continue;
      }
      target[key] = value;
      applied[key] = value;
    } else if (isJsonObject(existing) && isJsonObject(value)) {
      const nested = overrideJsonObject(existing, value, create, { ...options, path: keyPath });
      if (Object.keys(nested).length > 0) {
        applied[key] = nested;
      }
    } else {
      target[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}

export function appendJsonObject(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  options: JsonObjectMergeOptions
): Record<string, JsonValue> {
  const applied: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const keyPath = appendGeneratedPath(options.path ?? "", key);
    if (existing === undefined) {
      target[key] = value;
      applied[key] = value;
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
      applied[key] = value;
    } else if (isJsonObject(existing) && isJsonObject(value)) {
      const nested = appendJsonObject(existing, value, { ...options, path: keyPath });
      if (Object.keys(nested).length > 0) {
        applied[key] = nested;
      }
    } else {
      options.onError?.("rsgl.appendIncompatibleField", `append cannot merge field '${keyPath}' because the existing value is not an array or object compatible with the appended value.`, options.range);
    }
  }
  return applied;
}
