import type { JsonValue } from "../ir";
import { cloneJsonValue, isJsonObject } from "../jsonValues";

export type ValueMergeAction =
  | { kind: "assign"; value: JsonValue }
  | { kind: "recurse"; target: Record<string, JsonValue>; incoming: Record<string, JsonValue>; created: boolean }
  | { kind: "concatenate"; value: JsonValue[]; offset: number }
  | { kind: "reject" };

/** Resolve a mode and value pair into the primitive action performed by the engine. */
export function valueMergeAction(
  mode: "deep" | "strict" | "upsert" | "append",
  existing: JsonValue | undefined,
  incoming: JsonValue
): ValueMergeAction {
  if (existing === undefined) {
    if (mode === "strict") {
      return { kind: "reject" };
    }
    if (isJsonObject(incoming)) {
      return { kind: "recurse", target: {}, incoming, created: true };
    }
    return { kind: "assign", value: cloneJsonValue(incoming) };
  }

  if (isJsonObject(existing) && isJsonObject(incoming)) {
    return { kind: "recurse", target: existing, incoming, created: false };
  }

  if ((mode === "deep" || mode === "append") && Array.isArray(existing) && Array.isArray(incoming)) {
    return {
      kind: "concatenate",
      value: [...existing, ...incoming.map(cloneJsonValue)],
      offset: existing.length
    };
  }

  if (mode === "append") {
    return { kind: "reject" };
  }

  return { kind: "assign", value: cloneJsonValue(incoming) };
}
