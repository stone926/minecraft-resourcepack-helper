import type { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { ValidationRange } from "./validationTypes";

export function attachSourceFile(
  diagnostics: RsglCompileDiagnostic[],
  start: number,
  fileName: string | undefined
): void {
  if (!fileName) {
    return;
  }
  for (const diagnostic of diagnostics.slice(start)) {
    diagnostic.fileName ??= fileName;
  }
}

export function sourceFileForValidationRange(unit: ResourceUnit, range: ValidationRange): string {
  const referenceOrigins = unit.validation?.referenceOrigins ?? [];
  for (let index = referenceOrigins.length - 1; index >= 0; index--) {
    const origin = referenceOrigins[index];
    if (origin.sourceRange === range) {
      return origin.sourceFile;
    }
  }
  for (let index = referenceOrigins.length - 1; index >= 0; index--) {
    const origin = referenceOrigins[index];
    if (origin.sourceRange.start === range.start && origin.sourceRange.end === range.end) {
      return origin.sourceFile;
    }
  }
  for (let index = unit.sourceMap.mappings.length - 1; index >= 0; index--) {
    const mapping = unit.sourceMap.mappings[index];
    if (mapping.sourceRange.start === range.start && mapping.sourceRange.end === range.end) {
      return mapping.sourceFile;
    }
  }
  return unit.sourceMap.mappings[0]?.sourceFile ?? "<anonymous>";
}

export function sourceRangeForGeneratedPath(unit: ResourceUnit, generatedPath: string): ValidationRange {
  for (const path of generatedPathFallbacks(generatedPath)) {
    const origin = findLatestValidationOrigin(unit, path);
    if (origin) {
      return origin.sourceRange;
    }
  }
  const exactMapping = findLatestMapping(unit, generatedPath);
  if (exactMapping?.reason === "base") {
    // A base-owned field lives in an external JSON file. Diagnostics are sent
    // to the RSGL document, so anchor them to the `base` statement instead of
    // an unrelated later mapping for a parent object.
    return findLatestMappingRange(unit, "") ?? unitRange(unit);
  }
  for (const path of generatedPathFallbacks(generatedPath)) {
    const range = findLatestMappingRange(unit, path);
    if (range) {
      return range;
    }
  }
  return unitRange(unit);
}

export function unitRange(unit: ResourceUnit): ValidationRange {
  return unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 };
}

export function pushDiagnosticAtRange(
  diagnostics: RsglCompileDiagnostic[],
  code: string,
  message: string,
  severity: RsglCompileDiagnostic["severity"],
  range: ValidationRange,
  fileName?: string
): void {
  diagnostics.push({ code, message, severity, range, ...(fileName === undefined ? {} : { fileName }) });
}

export function pushUnitDiagnostic(
  diagnostics: RsglCompileDiagnostic[],
  unit: ResourceUnit,
  code: string,
  message: string,
  severity: RsglCompileDiagnostic["severity"] = "error",
  generatedPath?: string
): void {
  pushDiagnosticAtRange(
    diagnostics,
    code,
    message,
    severity,
    generatedPath === undefined ? unitRange(unit) : sourceRangeForGeneratedPath(unit, generatedPath)
  );
}

function generatedPathFallbacks(generatedPath: string): string[] {
  const paths: string[] = [];
  let current = generatedPath;
  while (current) {
    paths.push(current);
    const slash = current.lastIndexOf("/");
    current = slash > 0 ? current.slice(0, slash) : "";
  }
  paths.push("");
  return paths;
}

function findLatestValidationOrigin(
  unit: ResourceUnit,
  generatedPath: string
): { sourceFile: string; sourceRange: ValidationRange } | undefined {
  const origins = unit.validation?.referenceOrigins ?? [];
  for (let index = origins.length - 1; index >= 0; index--) {
    if (origins[index].generatedPath === generatedPath) {
      return origins[index];
    }
  }
  return undefined;
}

function findLatestMappingRange(unit: ResourceUnit, generatedPath: string): ValidationRange | undefined {
  return findLatestMapping(unit, generatedPath, false)?.sourceRange;
}

function findLatestMapping(
  unit: ResourceUnit,
  generatedPath: string,
  includeBase = true
): ResourceUnit["sourceMap"]["mappings"][number] | undefined {
  for (let index = unit.sourceMap.mappings.length - 1; index >= 0; index--) {
    const mapping = unit.sourceMap.mappings[index];
    if (mapping.generatedPath === generatedPath && (includeBase || mapping.reason !== "base")) {
      return mapping;
    }
  }
  return undefined;
}
