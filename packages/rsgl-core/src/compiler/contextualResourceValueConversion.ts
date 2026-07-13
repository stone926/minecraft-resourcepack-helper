import type { RsglType } from "../semantic/types";
import {
  isResourceValueKindAssignable,
  resourceValueKindForTypeKind,
  typeKindForResourceValueKind,
  type RsglResourceValueKind
} from "../resourceIdSemantics";
import {
  createEvaluatedResourceId,
  createEvaluatedTextureVariable,
  hasEvaluatedResourceValueBrand,
  isEvaluatedResourceId,
  isEvaluatedTextureVariable
} from "./evaluatedResourceValues";

export interface RsglContextualValueError {
  readonly code:
    | "rsgl.ambiguousResourceIdConversion"
    | "rsgl.invalidConstructedResourceId"
    | "rsgl.invalidTextureVariable"
    | "rsgl.resourceIdKindMismatch"
    | "rsgl.resourceReferenceExpected";
  readonly message: string;
}

export type RsglContextualValueResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RsglContextualValueError };

interface ContextualConversionSuccess {
  readonly kind: "success";
  readonly value: unknown;
  /** True only when contextual conversion changed the runtime representation. */
  readonly converted: boolean;
}

interface ContextualConversionIncompatible {
  readonly kind: "incompatible";
}

interface ContextualConversionError {
  readonly kind: "error";
  readonly error: RsglContextualValueError;
}

type ContextualConversionOutcome =
  | ContextualConversionSuccess
  | ContextualConversionIncompatible
  | ContextualConversionError;

interface ContextualConversionState {
  readonly ancestors: Set<object>;
}

/**
 * Applies an explicit semantic expected type to one already-evaluated value.
 *
 * The operation is pure and clone-on-change: imported or otherwise shared
 * containers are never rewritten for a caller namespace. JSON/Any/Unknown
 * deliberately remain opaque so ordinary strings are not guessed to be IDs.
 */
export function contextualizeEvaluatedValue(
  value: unknown,
  expectedType: RsglType,
  defaultNamespace: string
): RsglContextualValueResult {
  const outcome = convertForExpectedType(
    value,
    expectedType,
    defaultNamespace,
    { ancestors: new Set() },
    false
  );
  if (outcome.kind === "error") {
    return { ok: false, error: outcome.error };
  }
  return {
    ok: true,
    value: outcome.kind === "success" ? outcome.value : value
  };
}

/** Resource kinds represented directly by an expected type, excluding containers. */
export function contextualResourceKinds(
  expectedType: RsglType
): readonly RsglResourceValueKind[] {
  const kinds = new Set<RsglResourceValueKind>();
  collectContextualResourceKinds(expectedType, kinds);
  return [...kinds];
}

function collectContextualResourceKinds(
  expectedType: RsglType,
  kinds: Set<RsglResourceValueKind>
): void {
  const resourceKind = resourceValueKindForTypeKind(expectedType.kind);
  if (resourceKind) {
    kinds.add(resourceKind);
    return;
  }
  if (expectedType.kind === "TextureRef") {
    kinds.add("texture");
    return;
  }
  if (expectedType.kind === "Union") {
    for (const option of expectedType.options ?? []) {
      if (option.kind !== "Missing") {
        collectContextualResourceKinds(option, kinds);
      }
    }
  }
}

function convertForExpectedType(
  value: unknown,
  expectedType: RsglType,
  defaultNamespace: string,
  state: ContextualConversionState,
  strict: boolean
): ContextualConversionOutcome {
  const resourceKind = resourceValueKindForTypeKind(expectedType.kind);
  if (resourceKind) {
    return convertResourceId(value, resourceKind, defaultNamespace);
  }
  if (expectedType.kind === "TextureVariable") {
    return convertTextureVariable(value);
  }
  if (expectedType.kind === "TextureRef") {
    return convertTextureRef(value, defaultNamespace);
  }
  if (expectedType.kind === "List") {
    if (!Array.isArray(value)) {
      return strict ? incompatibleConversion : unchanged(value);
    }
    return convertList(value, expectedType.elementType, defaultNamespace, state);
  }
  if (expectedType.kind === "Object") {
    if (!isPlainRuntimeObject(value)) {
      return strict ? incompatibleConversion : unchanged(value);
    }
    return convertObject(value, expectedType, defaultNamespace, state);
  }
  if (expectedType.kind === "Union") {
    return convertUnion(value, expectedType.options ?? [], defaultNamespace, state);
  }
  if (expectedType.kind === "Missing") {
    return value === undefined ? unchanged(value) : strict ? incompatibleConversion : unchanged(value);
  }
  if (expectedType.kind === "Json" && expectedType.contextualEscapeOnly && strict) {
    return incompatibleConversion;
  }
  if (!strict || runtimeValueMatchesType(value, expectedType)) {
    return unchanged(value);
  }
  return incompatibleConversion;
}

function convertResourceId(
  value: unknown,
  expectedKind: RsglResourceValueKind,
  defaultNamespace: string
): ContextualConversionOutcome {
  if (isEvaluatedResourceId(value)) {
    if (isResourceValueKindAssignable(expectedKind, value.resourceKind)) {
      return unchanged(value);
    }
    return conversionError(
      "rsgl.resourceIdKindMismatch",
      `${typeKindForResourceValueKind(value.resourceKind)} cannot be used where ${typeKindForResourceValueKind(expectedKind)} is required.`
    );
  }
  if (isEvaluatedTextureVariable(value)) {
    return conversionError(
      "rsgl.resourceIdKindMismatch",
      `TextureVariable cannot be used where ${typeKindForResourceValueKind(expectedKind)} is required.`
    );
  }
  if (typeof value !== "string") {
    return conversionError(
      "rsgl.resourceReferenceExpected",
      `Expected ${typeKindForResourceValueKind(expectedKind)} text, but received ${describeRuntimeValue(value)}.`
    );
  }
  if (value.startsWith("#")) {
    return conversionError(
      "rsgl.resourceReferenceExpected",
      `Texture variable '${value}' cannot be converted to ${typeKindForResourceValueKind(expectedKind)}.`
    );
  }
  const converted = createEvaluatedResourceId(value, expectedKind, defaultNamespace);
  return converted
    ? changed(converted)
    : conversionError(
      "rsgl.invalidConstructedResourceId",
      `Invalid ${typeKindForResourceValueKind(expectedKind)} '${value}'.`
    );
}

function convertTextureVariable(value: unknown): ContextualConversionOutcome {
  if (isEvaluatedTextureVariable(value)) {
    return unchanged(value);
  }
  if (isEvaluatedResourceId(value)) {
    return conversionError(
      "rsgl.resourceIdKindMismatch",
      `${typeKindForResourceValueKind(value.resourceKind)} cannot be used where TextureVariable is required.`
    );
  }
  if (typeof value !== "string") {
    return conversionError(
      "rsgl.resourceReferenceExpected",
      `Expected TextureVariable text, but received ${describeRuntimeValue(value)}.`
    );
  }
  const converted = createEvaluatedTextureVariable(value);
  return converted
    ? changed(converted)
    : conversionError(
      "rsgl.invalidTextureVariable",
      `Invalid texture variable '${value}'.`
    );
}

function convertTextureRef(
  value: unknown,
  defaultNamespace: string
): ContextualConversionOutcome {
  if (isEvaluatedTextureVariable(value)) {
    return unchanged(value);
  }
  if (typeof value === "string" && value.startsWith("#")) {
    return convertTextureVariable(value);
  }
  return convertResourceId(value, "texture", defaultNamespace);
}

function convertList(
  value: readonly unknown[],
  elementType: RsglType | undefined,
  defaultNamespace: string,
  state: ContextualConversionState
): ContextualConversionOutcome {
  if (!elementType || state.ancestors.has(value)) {
    return unchanged(value);
  }
  state.ancestors.add(value);
  let converted = false;
  const result: unknown[] = [];
  for (const item of value) {
    const itemResult = convertForExpectedType(item, elementType, defaultNamespace, state, false);
    if (itemResult.kind === "error") {
      state.ancestors.delete(value);
      return itemResult;
    }
    const next = itemResult.kind === "success" ? itemResult.value : item;
    result.push(next);
    converted ||= next !== item;
  }
  state.ancestors.delete(value);
  return converted ? changed(result) : unchanged(value);
}

function convertObject(
  value: Record<string, unknown>,
  expectedType: RsglType,
  defaultNamespace: string,
  state: ContextualConversionState
): ContextualConversionOutcome {
  if (state.ancestors.has(value)) {
    return unchanged(value);
  }
  state.ancestors.add(value);
  let converted = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const itemType = expectedType.properties?.get(key)?.type ?? expectedType.indexType;
    if (!itemType) {
      result[key] = item;
      continue;
    }
    const itemResult = convertForExpectedType(item, itemType, defaultNamespace, state, false);
    if (itemResult.kind === "error") {
      state.ancestors.delete(value);
      return itemResult;
    }
    const next = itemResult.kind === "success" ? itemResult.value : item;
    result[key] = next;
    converted ||= next !== item;
  }
  state.ancestors.delete(value);
  return converted ? changed(result) : unchanged(value);
}

function convertUnion(
  value: unknown,
  options: readonly RsglType[],
  defaultNamespace: string,
  state: ContextualConversionState
): ContextualConversionOutcome {
  const outcomes = options.map(option =>
    convertForExpectedType(value, option, defaultNamespace, state, true)
  );
  const successes = outcomes.filter(
    (outcome): outcome is ContextualConversionSuccess => outcome.kind === "success"
  );
  const exact = successes.filter(outcome => !outcome.converted);
  const candidates = exact.length > 0 ? exact : successes;
  const unique = uniqueConversionValues(candidates);
  if (unique.length === 1) {
    return unique[0];
  }
  if (unique.length > 1) {
    const kinds = contextualResourceKinds({ kind: "Union", options: [...options] });
    return conversionError(
      "rsgl.ambiguousResourceIdConversion",
      kinds.length > 1
        ? `Resource ID conversion is ambiguous between ${kinds.map(typeKindForResourceValueKind).join(" and ")}.`
        : "Contextual resource value conversion is ambiguous."
    );
  }
  const errors = outcomes.filter(
    (outcome): outcome is ContextualConversionError => outcome.kind === "error"
  );
  return errors[0] ?? incompatibleConversion;
}

function runtimeValueMatchesType(value: unknown, type: RsglType): boolean {
  if (type.kind === "Any" || type.kind === "Unknown") {
    return true;
  }
  if (type.kind === "Json") {
    return !type.contextualEscapeOnly;
  }
  if (type.kind === "String" || type.kind === "Path") {
    return typeof value === "string";
  }
  if (type.kind === "Number") {
    return typeof value === "number";
  }
  if (type.kind === "Boolean") {
    return typeof value === "boolean";
  }
  if (type.kind === "Null") {
    return value === null;
  }
  if (type.kind === "List" || type.kind === "Range") {
    return Array.isArray(value);
  }
  if (type.kind === "Object" || type.kind === "BlockstateModelObject") {
    return isPlainRuntimeObject(value);
  }
  if (type.kind === "Function") {
    return isLambdaLikeRuntimeValue(value);
  }
  return false;
}

function isPlainRuntimeObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasEvaluatedResourceValueBrand(value)) {
    return false;
  }
  if (isLambdaLikeRuntimeValue(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLambdaLikeRuntimeValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { kind?: unknown; parameters?: unknown; body?: unknown };
  return candidate.kind === "lambda"
    && Array.isArray(candidate.parameters)
    && Boolean(candidate.body && typeof candidate.body === "object");
}

function uniqueConversionValues(
  candidates: readonly ContextualConversionSuccess[]
): ContextualConversionSuccess[] {
  const unique: ContextualConversionSuccess[] = [];
  for (const candidate of candidates) {
    if (!unique.some(existing => sameRuntimeValue(existing.value, candidate.value))) {
      unique.push(candidate);
    }
  }
  return unique;
}

function sameRuntimeValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (isEvaluatedResourceId(left) && isEvaluatedResourceId(right)) {
    return left.resourceKind === right.resourceKind
      && left.namespace === right.namespace
      && left.path === right.path;
  }
  if (isEvaluatedTextureVariable(left) && isEvaluatedTextureVariable(right)) {
    return left.value === right.value;
  }
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    return left.every((item, index) => sameRuntimeValue(item, right[index]));
  }
  if (isPlainRuntimeObject(left) && isPlainRuntimeObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.hasOwn(right, key) && sameRuntimeValue(left[key], right[key]));
  }
  return false;
}

function describeRuntimeValue(value: unknown): string {
  if (value === undefined) {
    return "an undefined value";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

function unchanged(value: unknown): ContextualConversionSuccess {
  return { kind: "success", value, converted: false };
}

function changed(value: unknown): ContextualConversionSuccess {
  return { kind: "success", value, converted: true };
}

function conversionError(
  code: RsglContextualValueError["code"],
  message: string
): ContextualConversionError {
  return { kind: "error", error: { code, message } };
}

const incompatibleConversion: ContextualConversionIncompatible = { kind: "incompatible" };
