import type {
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglMapping,
  RsglValidationReferenceOrigin
} from "./ir";
import type { ValidationRange } from "./validationTypes";

interface ValidationSourceLookup {
  readonly mappings: readonly RsglMapping[];
  readonly mappingCount: number;
  readonly origins: readonly RsglValidationReferenceOrigin[];
  readonly originCount: number;
  readonly latestMappingByPath: ReadonlyMap<string, RsglMapping>;
  readonly latestNonBaseMappingByPath: ReadonlyMap<string, RsglMapping>;
  readonly latestOriginByPath: ReadonlyMap<string, RsglValidationReferenceOrigin>;
  readonly originFileByRange: ReadonlyMap<ValidationRange, string>;
  readonly originFileByCoordinates: ReadonlyMap<string, string>;
  readonly mappingFileByCoordinates: ReadonlyMap<string, string>;
}

const validationSourceLookups = new WeakMap<ResourceUnit, ValidationSourceLookup>();
const noValidationOrigins: readonly RsglValidationReferenceOrigin[] = [];

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
  const lookup = validationSourceLookup(unit);
  const coordinateKey = rangeCoordinatesKey(range);
  const sourceFile = lookup.originFileByRange.get(range)
    ?? lookup.originFileByCoordinates.get(coordinateKey)
    ?? lookup.mappingFileByCoordinates.get(coordinateKey);
  if (sourceFile) {
    return sourceFile;
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
  return validationSourceLookup(unit).latestOriginByPath.get(generatedPath);
}

function findLatestMappingRange(unit: ResourceUnit, generatedPath: string): ValidationRange | undefined {
  return findLatestMapping(unit, generatedPath, false)?.sourceRange;
}

function findLatestMapping(
  unit: ResourceUnit,
  generatedPath: string,
  includeBase = true
): ResourceUnit["sourceMap"]["mappings"][number] | undefined {
  const lookup = validationSourceLookup(unit);
  return (includeBase
    ? lookup.latestMappingByPath
    : lookup.latestNonBaseMappingByPath
  ).get(generatedPath);
}

function validationSourceLookup(unit: ResourceUnit): ValidationSourceLookup {
  const mappings = unit.sourceMap.mappings;
  const origins = unit.validation?.referenceOrigins ?? noValidationOrigins;
  const cached = validationSourceLookups.get(unit);
  if (
    cached
    && cached.mappings === mappings
    && cached.mappingCount === mappings.length
    && cached.origins === origins
    && cached.originCount === origins.length
  ) {
    return cached;
  }

  const latestMappingByPath = new Map<string, RsglMapping>();
  const latestNonBaseMappingByPath = new Map<string, RsglMapping>();
  const mappingFileByCoordinates = new Map<string, string>();
  for (const mapping of mappings) {
    latestMappingByPath.set(mapping.generatedPath, mapping);
    if (mapping.reason !== "base") {
      latestNonBaseMappingByPath.set(mapping.generatedPath, mapping);
    }
    mappingFileByCoordinates.set(rangeCoordinatesKey(mapping.sourceRange), mapping.sourceFile);
  }

  const latestOriginByPath = new Map<string, RsglValidationReferenceOrigin>();
  const originFileByRange = new Map<ValidationRange, string>();
  const originFileByCoordinates = new Map<string, string>();
  for (const origin of origins) {
    latestOriginByPath.set(origin.generatedPath, origin);
    originFileByRange.set(origin.sourceRange, origin.sourceFile);
    originFileByCoordinates.set(rangeCoordinatesKey(origin.sourceRange), origin.sourceFile);
  }

  const lookup: ValidationSourceLookup = {
    mappings,
    mappingCount: mappings.length,
    origins,
    originCount: origins.length,
    latestMappingByPath,
    latestNonBaseMappingByPath,
    latestOriginByPath,
    originFileByRange,
    originFileByCoordinates,
    mappingFileByCoordinates
  };
  validationSourceLookups.set(unit, lookup);
  return lookup;
}

function rangeCoordinatesKey(range: ValidationRange): string {
  return `${range.start}:${range.end}`;
}
