import type { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

export interface ItemModelDepthViolation {
  readonly depth: number;
  readonly generatedPath: string;
}

/**
 * Finds the first expanded item-model node beyond the configured edge depth.
 * This operates on final JSON so raw expressions, base documents, and merges
 * receive the same guard as structured AST nodes.
 */
export function findItemModelDepthViolation(
  value: JsonValue,
  maxDepth: number,
  generatedPath = "/model"
): ItemModelDepthViolation | undefined {
  return visitItemModel(value, 0, maxDepth, generatedPath);
}

function visitItemModel(
  value: JsonValue,
  depth: number,
  maxDepth: number,
  generatedPath: string
): ItemModelDepthViolation | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (depth > maxDepth) {
    return { depth, generatedPath };
  }

  const type = canonicalType(value.type);
  if (type === "condition") {
    return visitNamedChild(value, "on_true", depth, maxDepth, generatedPath)
      ?? visitNamedChild(value, "on_false", depth, maxDepth, generatedPath);
  }
  if (type === "composite") {
    return visitModelArray(value.models, "models", depth, maxDepth, generatedPath);
  }
  if (type === "select") {
    if (Array.isArray(value.cases)) {
      for (let index = 0; index < value.cases.length; index += 1) {
        const entry = value.cases[index];
        if (!isJsonObject(entry)) {
          continue;
        }
        const childPath = appendGeneratedPath(
          appendGeneratedPath(
            appendGeneratedPath(generatedPath, "cases"),
            String(index)
          ),
          "model"
        );
        const violation = visitItemModel(entry.model, depth + 1, maxDepth, childPath);
        if (violation) {
          return violation;
        }
      }
    }
    return visitOptionalFallback(value, depth, maxDepth, generatedPath);
  }
  if (type === "range_dispatch") {
    if (Array.isArray(value.entries)) {
      for (let index = 0; index < value.entries.length; index += 1) {
        const entry = value.entries[index];
        if (!isJsonObject(entry)) {
          continue;
        }
        const childPath = appendGeneratedPath(
          appendGeneratedPath(
            appendGeneratedPath(generatedPath, "entries"),
            String(index)
          ),
          "model"
        );
        const violation = visitItemModel(entry.model, depth + 1, maxDepth, childPath);
        if (violation) {
          return violation;
        }
      }
    }
    return visitOptionalFallback(value, depth, maxDepth, generatedPath);
  }
  return undefined;
}

function visitNamedChild(
  owner: Record<string, JsonValue>,
  child: string,
  depth: number,
  maxDepth: number,
  generatedPath: string
): ItemModelDepthViolation | undefined {
  return visitItemModel(
    owner[child],
    depth + 1,
    maxDepth,
    appendGeneratedPath(generatedPath, child)
  );
}

function visitModelArray(
  value: JsonValue,
  property: string,
  depth: number,
  maxDepth: number,
  generatedPath: string
): ItemModelDepthViolation | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const childPath = appendGeneratedPath(
      appendGeneratedPath(generatedPath, property),
      String(index)
    );
    const violation = visitItemModel(value[index], depth + 1, maxDepth, childPath);
    if (violation) {
      return violation;
    }
  }
  return undefined;
}

function visitOptionalFallback(
  owner: Record<string, JsonValue>,
  depth: number,
  maxDepth: number,
  generatedPath: string
): ItemModelDepthViolation | undefined {
  return Object.hasOwn(owner, "fallback")
    ? visitNamedChild(owner, "fallback", depth, maxDepth, generatedPath)
    : undefined;
}

function canonicalType(value: JsonValue): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
