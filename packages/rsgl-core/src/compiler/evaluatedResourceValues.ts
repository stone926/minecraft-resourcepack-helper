import type { TextRange } from "../parser";
import {
  isResourceValueKindAssignable,
  type RsglResourceValueKind
} from "../resourceIdSemantics";
import { parseResourceId, resourceIdToString } from "./resourceIds";

/**
 * Runtime-only nominal identity for compiler-created resource values.
 *
 * The symbol intentionally stays private to this module: ordinary RSGL JSON
 * objects may use the same public field names without becoming compiler tags.
 */
const evaluatedResourceValueBrand: unique symbol = Symbol("rsgl.evaluatedResourceValue");

export interface RsglEvaluatedResourceId {
  readonly [evaluatedResourceValueBrand]: typeof evaluatedResourceValueBrand;
  readonly kind: "resourceId";
  readonly resourceKind: RsglResourceValueKind;
  readonly namespace: string;
  readonly path: string;
}

export interface RsglEvaluatedTextureVariable {
  readonly [evaluatedResourceValueBrand]: typeof evaluatedResourceValueBrand;
  readonly kind: "textureVariable";
  /** Canonical runtime spelling, including the leading '#'. */
  readonly value: string;
}

export type RsglEvaluatedResourceValue =
  | RsglEvaluatedResourceId
  | RsglEvaluatedTextureVariable;

export interface RsglResourceValueObservation {
  readonly generatedPath: string;
  readonly valueKind: RsglResourceValueKind | "textureVariable";
  readonly range: TextRange;
  /** Selected value syntax, kept separate from the diagnostic/source-map location. */
  readonly valueLocation?: {
    readonly range: TextRange;
    readonly sourceFile?: string;
  };
  readonly sourceFile?: string;
}

export function createEvaluatedResourceId(
  value: string,
  resourceKind: RsglResourceValueKind,
  defaultNamespace: string
): RsglEvaluatedResourceId | null {
  const parsed = parseResourceId(value, defaultNamespace);
  return parsed
    ? {
      [evaluatedResourceValueBrand]: evaluatedResourceValueBrand,
      kind: "resourceId",
      resourceKind,
      namespace: parsed.namespace,
      path: parsed.path
    }
    : null;
}

export function createEvaluatedTextureVariable(
  value: string
): RsglEvaluatedTextureVariable | null {
  return /^#[A-Za-z0-9_.\-/]+$/.test(value)
    ? {
      [evaluatedResourceValueBrand]: evaluatedResourceValueBrand,
      kind: "textureVariable",
      value
    }
    : null;
}

export function isEvaluatedResourceId(value: unknown): value is RsglEvaluatedResourceId {
  if (!hasEvaluatedResourceValueBrand(value)) {
    return false;
  }
  const candidate = value as Partial<RsglEvaluatedResourceId>;
  return candidate.kind === "resourceId"
    && (candidate.resourceKind === "generic"
      || candidate.resourceKind === "model"
      || candidate.resourceKind === "texture")
    && typeof candidate.namespace === "string"
    && typeof candidate.path === "string";
}

export function isEvaluatedTextureVariable(
  value: unknown
): value is RsglEvaluatedTextureVariable {
  if (!hasEvaluatedResourceValueBrand(value)) {
    return false;
  }
  const candidate = value as Partial<RsglEvaluatedTextureVariable>;
  return candidate.kind === "textureVariable" && typeof candidate.value === "string";
}

export function isEvaluatedResourceValue(
  value: unknown
): value is RsglEvaluatedResourceValue {
  return isEvaluatedResourceId(value) || isEvaluatedTextureVariable(value);
}

/**
 * Detects compiler-created tags even when their public payload was corrupted.
 * This lets JSON lowering reject an internal malformed value without reserving
 * the corresponding object shape for ordinary user JSON.
 */
export function hasEvaluatedResourceValueBrand(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as { [evaluatedResourceValueBrand]?: unknown })[evaluatedResourceValueBrand]
        === evaluatedResourceValueBrand
  );
}

export function evaluatedResourceIdToString(value: RsglEvaluatedResourceId): string {
  return resourceIdToString({ namespace: value.namespace, path: value.path });
}

export function evaluatedResourceValueToString(
  value: RsglEvaluatedResourceValue
): string {
  return isEvaluatedResourceId(value) ? evaluatedResourceIdToString(value) : value.value;
}

export function evaluationScalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return isEvaluatedResourceValue(value) ? evaluatedResourceValueToString(value) : null;
}

export function isEvaluatedResourceKindAssignable(
  expected: RsglResourceValueKind,
  value: RsglEvaluatedResourceId
): boolean {
  return isResourceValueKindAssignable(expected, value.resourceKind);
}
