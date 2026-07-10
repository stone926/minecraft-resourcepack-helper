import type { JsonValue } from "../ir";
import { isJsonObject } from "../jsonValues";

/** Relocate an incoming JSON-pointer mapping after one or more array concatenations. */
export function offsetFragmentMappingPath(
  generatedPath: string,
  offsets: ReadonlyMap<string, number>
): string {
  const paths = Array.from(offsets.keys()).sort((left, right) => right.length - left.length);
  for (const path of paths) {
    const offset = offsets.get(path);
    if (!offset || !generatedPath.startsWith(`${path}/`)) {
      continue;
    }
    const rest = generatedPath.slice(path.length + 1);
    const match = /^(\d+)(\/.*)?$/.exec(rest);
    if (match) {
      return `${path}/${Number(match[1]) + offset}${match[2] ?? ""}`;
    }
  }
  return generatedPath;
}

/** Return whether a fragment-local mapping belongs to content accepted by the merge policy. */
export function mappingTargetsAppliedContent(
  generatedPath: string,
  applied: Readonly<Record<string, JsonValue>>
): boolean {
  if (!generatedPath) {
    return Object.keys(applied).length > 0;
  }

  let current: JsonValue = applied as Record<string, JsonValue>;
  for (const encodedSegment of generatedPath.split("/").slice(1)) {
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
        return false;
      }
      current = current[Number(segment)];
    } else if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}
