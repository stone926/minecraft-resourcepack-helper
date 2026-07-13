import type { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  canonicalizeResourceReference,
  type RsglResourceReferenceConsumer,
  type RsglResourceReferenceConsumerContext
} from "./resourceReferenceConsumers";
import { checkResourceExists, resourceLabel } from "./resourceReferenceValidation";
import { pushDiagnosticAtRange, sourceFileForValidationRange, unitRange } from "./validationDiagnostics";
import type {
  RsglCheckedResourceReference,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  ValidationRange
} from "./validationTypes";

type JsonReferenceOwner = Record<string, JsonValue> | JsonValue[];

/** Canonicalizes a known JSON sink that has no existence-resolution contract. */
export function canonicalizeJsonResourceReference(
  owner: JsonReferenceOwner,
  key: string | number,
  consumer: RsglResourceReferenceConsumer,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  defaultNamespace: string = unit.id?.namespace ?? "minecraft",
  consumerContext: RsglResourceReferenceConsumerContext = {}
): string | null {
  const rawValue = jsonReferenceValue(owner, key);
  if (typeof rawValue !== "string") {
    return null;
  }
  const reference = canonicalizeResourceReference(consumer, rawValue, defaultNamespace, consumerContext);
  if (reference.kind === "invalid") {
    pushInvalidReferenceDiagnostic(reference.targetKind, rawValue, unit, diagnostics, range);
    return null;
  }
  if (reference.kind === "textureVariable") {
    return null;
  }
  writeJsonReferenceValue(owner, key, reference.id);
  return reference.id;
}

/**
 * Resolves a known JSON resource-reference sink and replaces it with its
 * canonical emitted ID. Folder-aware consumers may use a distinct canonical
 * physical lookup ID. Generic JSON fields must not call this helper.
 */
export function checkJsonResourceReference(
  owner: JsonReferenceOwner,
  key: string | number,
  consumer: RsglResourceReferenceConsumer,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  externScopeFile?: string,
  defaultNamespace: string = unit.id?.namespace ?? "minecraft",
  consumerContext: RsglResourceReferenceConsumerContext = {}
): RsglCheckedResourceReference {
  const rawValue = jsonReferenceValue(owner, key);
  if (typeof rawValue !== "string") {
    return { available: false, external: false };
  }
  const checked = checkResourceExists(
    consumer,
    rawValue,
    unit,
    options,
    diagnostics,
    range,
    externScopeFile,
    defaultNamespace,
    consumerContext
  );
  if (checked.canonicalId) {
    writeJsonReferenceValue(owner, key, checked.canonicalId);
  }
  return checked;
}

function jsonReferenceValue(owner: JsonReferenceOwner, key: string | number): JsonValue | undefined {
  return Array.isArray(owner) ? owner[Number(key)] : owner[String(key)];
}

function writeJsonReferenceValue(owner: JsonReferenceOwner, key: string | number, value: string): void {
  if (Array.isArray(owner)) {
    owner[Number(key)] = value;
  } else {
    owner[String(key)] = value;
  }
}

function pushInvalidReferenceDiagnostic(
  kind: RsglResourceExistenceKind,
  rawValue: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  pushDiagnosticAtRange(
    diagnostics,
    "rsgl.invalidResourceReference",
    `${resourceLabel(kind)} reference '${rawValue}' is not a valid resource location.`,
    "error",
    range,
    sourceFileForValidationRange(unit, range)
  );
}
