import {
  isResourceValueKindAssignable,
  typeKindForResourceValueKind
} from "../resourceIdSemantics";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import type { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  resourceConsumerAllowsTextureVariable,
  resourceValueKindForConsumer,
  type RsglResourceReferenceConsumer
} from "./resourceReferenceConsumers";
import { pushDiagnosticAtRange } from "./validationDiagnostics";
import type { ValidationRange } from "./validationTypes";

interface ResourceValueValidationSession {
  visitedTextureVariables: Set<string>;
}

const validationSessions = new WeakMap<ResourceUnit, ResourceValueValidationSession>();

/** Opens a synchronous per-unit validation session for unconsumed texture values. */
export function beginResourceValueValidation(unit: ResourceUnit): void {
  validationSessions.set(unit, { visitedTextureVariables: new Set() });
}

/**
 * Diagnoses TextureVariable values that never reached a TextureRef consumer,
 * including values escaped into generic JSON fields.
 */
export function completeResourceValueValidation(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const session = validationSessions.get(unit);
  validationSessions.delete(unit);
  const visited = session?.visitedTextureVariables ?? new Set<string>();
  for (const observation of effectiveObservations(unit)) {
    if (observation.valueKind !== "textureVariable" || visited.has(observation.generatedPath)) {
      continue;
    }
    pushObservationDiagnostic(
      diagnostics,
      observation,
      "rsgl.textureVariableInvalidContext",
      "TextureVariable values are only valid in model texture-reference fields."
    );
  }
}

/** Returns false after one dedicated diagnostic when a typed value is incompatible. */
export function validateResourceValueConsumer(
  unit: ResourceUnit,
  consumer: RsglResourceReferenceConsumer,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  generatedPath?: string
): boolean {
  const observation = resourceValueObservation(unit, range, generatedPath);
  if (!observation) {
    return true;
  }

  if (observation.valueKind === "textureVariable") {
    validationSessions.get(unit)?.visitedTextureVariables.add(observation.generatedPath);
    if (resourceConsumerAllowsTextureVariable(consumer)) {
      return true;
    }
    pushObservationDiagnostic(
      diagnostics,
      observation,
      "rsgl.textureVariableInvalidContext",
      "TextureVariable values are only valid in model texture-reference fields."
    );
    return false;
  }

  const expectedKind = resourceValueKindForConsumer(consumer);
  if (isResourceValueKindAssignable(expectedKind, observation.valueKind)) {
    return true;
  }
  pushObservationDiagnostic(
    diagnostics,
    observation,
    "rsgl.resourceIdKindMismatch",
    `${typeKindForResourceValueKind(observation.valueKind)} cannot be used where ${typeKindForResourceValueKind(expectedKind)} is required.`
  );
  return false;
}

function resourceValueObservation(
  unit: ResourceUnit,
  range: ValidationRange,
  generatedPath: string | undefined
): RsglResourceValueObservation | undefined {
  if (generatedPath !== undefined) {
    return resourceValueObservationForGeneratedPath(unit, generatedPath);
  }
  const observations = unit.validation?.resourceValueObservations ?? [];
  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index];
    if (observation.range === range
      || (observation.range.start === range.start && observation.range.end === range.end)) {
      return observation;
    }
  }
  return undefined;
}

/** Returns the effective typed value observation at one final JSON path. */
export function resourceValueObservationForGeneratedPath(
  unit: ResourceUnit,
  generatedPath: string
): RsglResourceValueObservation | undefined {
  const observations = unit.validation?.resourceValueObservations ?? [];
  for (let index = observations.length - 1; index >= 0; index--) {
    if (observations[index].generatedPath === generatedPath) {
      return observations[index];
    }
  }
  return undefined;
}

function effectiveObservations(unit: ResourceUnit): RsglResourceValueObservation[] {
  const byPath = new Map<string, RsglResourceValueObservation>();
  for (const observation of unit.validation?.resourceValueObservations ?? []) {
    byPath.set(observation.generatedPath, observation);
  }
  return [...byPath.values()];
}

function pushObservationDiagnostic(
  diagnostics: RsglCompileDiagnostic[],
  observation: RsglResourceValueObservation,
  code: string,
  message: string
): void {
  if (diagnostics.some(diagnostic =>
    diagnostic.code === code
    && diagnostic.range.start === observation.range.start
    && diagnostic.range.end === observation.range.end
    && diagnostic.fileName === observation.sourceFile
  )) {
    return;
  }
  pushDiagnosticAtRange(
    diagnostics,
    code,
    message,
    "error",
    observation.range,
    observation.sourceFile
  );
}
