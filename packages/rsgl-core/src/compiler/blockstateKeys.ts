import { JsonValue } from "./ir";

export function blockstateVariantKey(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(",");
}
