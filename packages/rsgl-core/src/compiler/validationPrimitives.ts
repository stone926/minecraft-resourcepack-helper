import type { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";
import { pushUnitDiagnostic } from "./validationDiagnostics";

export interface UnitValidationIssue {
  code: string;
  message: string;
  severity?: RsglCompileDiagnostic["severity"];
  generatedPath?: string;
}

export interface BooleanFieldValidationOptions {
  label?: string;
  generatedPath?: string;
}

export function requireObject(
  value: unknown,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): Record<string, JsonValue> | null {
  const object = asObject(value);
  if (!object) {
    reportIssue(unit, diagnostics, issue);
  }
  return object;
}

export function requireArray(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): JsonValue[] | null {
  if (!Array.isArray(value)) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requireString(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): string | null {
  if (typeof value !== "string") {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requireBoolean(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): boolean | null {
  if (typeof value !== "boolean") {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requireFiniteNumber(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): number | null {
  if (!isFiniteNumber(value)) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requireNumberInRange(
  value: JsonValue | undefined,
  min: number,
  max: number,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): number | null {
  if (!isFiniteNumber(value) || value < min || value > max) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requirePositiveInteger(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): number | null {
  if (!isPositiveInteger(value)) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requirePositiveNumber(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): number | null {
  if (!isFiniteNumber(value) || value <= 0) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value;
}

export function requireEnum<T extends string>(
  value: JsonValue | undefined,
  allowed: ReadonlySet<T> | readonly T[],
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): T | null {
  const contains = typeof value === "string"
    && ("has" in allowed
      ? allowed.has(value as T)
      : (allowed as readonly T[]).includes(value as T));
  if (!contains) {
    reportIssue(unit, diagnostics, issue);
    return null;
  }
  return value as T;
}

export function validateStringField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object) {
    requireString(object[field], unit, diagnostics, { code, message: `Field '${field}' must be a string.` });
  }
}

export function validateBooleanField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  options: BooleanFieldValidationOptions = {}
): void {
  if (!(field in object)) {
    return;
  }
  const label = options.label ?? "Field";
  const fieldPath = options.generatedPath === undefined
    ? undefined
    : appendGeneratedPath(options.generatedPath, field);
  requireBoolean(object[field], unit, diagnostics, {
    code,
    message: `${label} '${field}' must be a boolean.`,
    generatedPath: fieldPath
  });
}

export function asObject(value: unknown): Record<string, JsonValue> | null {
  return isJsonObject(value) ? value : null;
}

export function stripMinecraftPrefix(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export { isJsonObject as isObject } from "./jsonValues";

function reportIssue(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  issue: UnitValidationIssue
): void {
  pushUnitDiagnostic(
    diagnostics,
    unit,
    issue.code,
    issue.message,
    issue.severity ?? "error",
    issue.generatedPath
  );
}
