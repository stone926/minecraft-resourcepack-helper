import type { PropertyKeyNode } from "./types";

/** Returns the compile-time spelling of a non-computed property key. */
export function staticPropertyKeyName(key: PropertyKeyNode): string | undefined {
  switch (key.kind) {
    case "Identifier":
      return key.text;
    case "StringLiteral":
      return key.value;
    case "NumberLiteral":
      return key.raw;
    case "DynamicKey":
      return undefined;
  }
}
