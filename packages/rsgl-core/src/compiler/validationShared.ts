import {
  compareExternPatternSpecificity,
  externResourcePatternMatches,
  type ExternResourceSource,
  type RsglExternDeclaration,
  type RsglGlobalExternConfigEntry
} from "../externDeclarations";
import { getExternResourceKindForTargetKind } from "../resourceKinds";
import { ExternalResourceKind, JsonValue, ResourceId, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { RsglBlockstateSchema } from "./blockstateStateValidation";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

const virtualVanillaBuiltinModelPrefix = "minecraft:builtin/";

export type RsglResourceExistenceKind =
  | "model"
  | "blockstate"
  | "item"
  | "texture"
  | "textureDirectory"
  | "sound"
  | "font"
  | "fontFile"
  | "shaderVertex"
  | "shaderFragment";
export type RsglResourceContentKind = "model";

export interface RsglTextureMetadata {
  width: number;
  height: number;
}

export interface RsglSoundMetadata {
  codec?: string;
  channels?: number;
  sampleRate?: number;
  durationSeconds?: number;
}

export type ValidationRange = RsglCompileDiagnostic["range"];

export interface RsglExternalResourceUsage {
  source: ExternResourceSource;
  resourceKind: ExternalResourceKind;
  targetKind: RsglResourceExistenceKind;
  id: string;
  skipExistenceCheck: boolean;
  sourceFile: string;
  range: ValidationRange;
  resolvedPath?: string;
}

export interface RsglCheckedResourceReference {
  available: boolean;
  external: boolean;
  source?: ExternResourceSource;
}

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  /** Global declarations normally supplied by rsgl.config.json. */
  globalExterns?: readonly RsglGlobalExternConfigEntry[];
  /** Defaults to true. False has the same existence-check effect as extern!. */
  checkExternExistence?: boolean;
  /** Normalized local and global declarations assembled by the compile pipeline. */
  externDeclarations?: readonly RsglExternDeclaration[];
  resourceExists?: (kind: RsglResourceExistenceKind, id: string) => boolean;
  resourceContent?: (kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  textureMetadata?: (id: string) => RsglTextureMetadata | null | undefined;
  soundMetadata?: (id: string) => RsglSoundMetadata | null | undefined;
  blockstateSchema?: (id: ResourceId) => RsglBlockstateSchema | null | undefined;
  externResourceExists?: (source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string) => boolean;
  externResourcePath?: (source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string) => string | null;
  externResourceContent?: (source: ExternResourceSource, kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  externTextureMetadata?: (source: ExternResourceSource, id: string) => RsglTextureMetadata | null | undefined;
  externSoundMetadata?: (source: ExternResourceSource, id: string) => RsglSoundMetadata | null | undefined;
  externBlockstateSchema?: (source: ExternResourceSource, id: ResourceId) => RsglBlockstateSchema | null | undefined;
  /** Internal compile-pipeline collector used to build concrete manifest dependencies. */
  onExternResourceUsed?: (usage: RsglExternalResourceUsage) => void;
  /** Internal generated-resource index used to exempt outputs from extern declarations. */
  generatedResourceIds?: ReadonlyMap<RsglResourceExistenceKind, ReadonlySet<string>>;
}

export function attachSourceFile(diagnostics: RsglCompileDiagnostic[], start: number, fileName: string | undefined): void {
  if (!fileName) {
    return;
  }
  for (const diagnostic of diagnostics.slice(start)) {
    diagnostic.fileName ??= fileName;
  }
}

export function checkResourceExists(
  kind: RsglResourceExistenceKind,
  id: string,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit> | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  externScopeFile?: string
): RsglCheckedResourceReference {
  if ((kind === "model" && generatedModels?.has(id)) || options.generatedResourceIds?.get(kind)?.has(id)) {
    return { available: true, external: false };
  }
  if (kind === "model" && isVirtualBuiltinModelId(id)) {
    return { available: true, external: false };
  }

  const sourceFile = sourceFileForValidationRange(unit, range);
  const declaration = resolveExternDeclaration(
    kind,
    id,
    externScopeFile ?? sourceFile,
    sourceFile,
    options,
    diagnostics,
    range
  );
  if (!declaration) {
    return { available: false, external: true };
  }

  const skipExistenceCheck = declaration.skipExistenceCheck
    || declaration.checkExistence === false
    || (declaration.checkExistence === undefined && options.checkExternExistence === false);
  const resolvedPath = skipExistenceCheck
    ? null
    : options.externResourcePath?.(declaration.source, kind, id);
  const exists = skipExistenceCheck
    ? true
    : resolvedPath !== undefined
      ? resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(declaration.source, kind, id)
        : (options.resourceExists?.(kind, id) ?? false);
  options.onExternResourceUsed?.({
    source: declaration.source,
    resourceKind: declaration.resourceKind,
    targetKind: kind,
    id,
    skipExistenceCheck,
    sourceFile,
    range,
    ...(resolvedPath ? { resolvedPath } : {})
  });
  if (exists) {
    return { available: true, external: true, source: declaration.source };
  }

  diagnostics.push({
    code: resourceNotFoundCode(kind),
    message: `${resourceLabel(kind)} not found: ${id}`,
    severity: "warning",
    range,
    fileName: sourceFile
  });
  return { available: false, external: true, source: declaration.source };
}

/**
 * Checks a resource referenced by already-loaded external content. Its source
 * is inherited from that content, while the concrete usage is still recorded
 * for manifests and dependency watching.
 */
export function checkInheritedExternalResourceExists(
  kind: RsglResourceExistenceKind,
  id: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  fallbackExists: boolean
): boolean {
  if (options.generatedResourceIds?.get(kind)?.has(id)) {
    return true;
  }
  const sourceFile = sourceFileForValidationRange(unit, range);
  const skipExistenceCheck = options.checkExternExistence === false;
  const resolvedPath = skipExistenceCheck
    ? null
    : options.externResourcePath?.(source, kind, id);
  const exists = skipExistenceCheck
    ? true
    : resolvedPath !== undefined
      ? resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(source, kind, id)
        : (options.resourceExists?.(kind, id) ?? fallbackExists);
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (resourceKind) {
    options.onExternResourceUsed?.({
      source,
      resourceKind,
      targetKind: kind,
      id,
      skipExistenceCheck,
      sourceFile,
      range,
      ...(resolvedPath ? { resolvedPath } : {})
    });
  }
  if (!exists) {
    diagnostics.push({
      code: resourceNotFoundCode(kind),
      message: `${resourceLabel(kind)} not found: ${id}`,
      severity: "warning",
      range,
      fileName: sourceFile
    });
  }
  return exists;
}

function resolveExternDeclaration(
  kind: RsglResourceExistenceKind,
  id: string,
  externScopeFile: string,
  diagnosticFile: string,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): RsglExternDeclaration | null {
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (!resourceKind) {
    diagnostics.push({
      code: "rsgl.undeclaredExternalResource",
      message: `${resourceLabel(kind)} '${id}' cannot be declared by any supported extern kind.`,
      severity: "error",
      range,
      fileName: diagnosticFile
    });
    return null;
  }

  const matches = (options.externDeclarations ?? []).filter(declaration =>
    declaration.resourceKind === resourceKind
    && externResourcePatternMatches(declaration.pattern, id)
  );
  const normalizedSourceFile = normalizeValidationFileName(externScopeFile);
  const localMatches = matches.filter(declaration =>
    declaration.fileName !== undefined
    && normalizeValidationFileName(declaration.fileName) === normalizedSourceFile
  );
  const candidates = localMatches.length > 0
    ? localMatches
    : matches.filter(declaration => declaration.fileName === undefined);
  if (candidates.length === 0) {
    diagnostics.push({
      code: "rsgl.undeclaredExternalResource",
      message: `${resourceLabel(kind)} '${id}' is external and must be declared with extern in ${externScopeFile} or rsgl.config.json.`,
      severity: "error",
      range,
      fileName: diagnosticFile
    });
    return null;
  }

  const sorted = [...candidates].sort((left, right) =>
    compareExternPatternSpecificity(right.pattern, left.pattern)
  );
  const selected = sorted[0];
  const equallySpecific = sorted.filter(candidate =>
    compareExternPatternSpecificity(candidate.pattern, selected.pattern) === 0
  );
  const sources = new Set(equallySpecific.map(candidate => candidate.source));
  if (sources.size > 1) {
    diagnostics.push({
      code: "rsgl.ambiguousExternalResource",
      message: `${resourceLabel(kind)} '${id}' matches equally specific custom and vanilla extern declarations.`,
      severity: "error",
      range,
      fileName: diagnosticFile
    });
    return null;
  }

  return equallySpecific.find(candidate => candidate.skipExistenceCheck) ?? selected;
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

function normalizeValidationFileName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isVirtualBuiltinModelId(id: string): boolean {
  return id.startsWith(virtualVanillaBuiltinModelPrefix);
}

export function itemModelType(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

export function resourceNotFoundCode(kind: RsglResourceExistenceKind): string {
  if (kind === "model") {
    return "rsgl.modelNotFound";
  }
  if (kind === "blockstate") {
    return "rsgl.blockstateNotFound";
  }
  if (kind === "item") {
    return "rsgl.itemNotFound";
  }
  if (kind === "textureDirectory") {
    return "rsgl.textureDirectoryNotFound";
  }
  if (kind === "texture") {
    return "rsgl.textureNotFound";
  }
  if (kind === "font") {
    return "rsgl.fontNotFound";
  }
  if (kind === "fontFile") {
    return "rsgl.fontFileNotFound";
  }
  if (kind === "shaderVertex") {
    return "rsgl.vertexShaderNotFound";
  }
  if (kind === "shaderFragment") {
    return "rsgl.fragmentShaderNotFound";
  }
  return "rsgl.soundNotFound";
}

export function resourceLabel(kind: RsglResourceExistenceKind): string {
  if (kind === "model") {
    return "Model";
  }
  if (kind === "blockstate") {
    return "Blockstate";
  }
  if (kind === "item") {
    return "Item";
  }
  if (kind === "textureDirectory") {
    return "Texture directory";
  }
  if (kind === "texture") {
    return "Texture";
  }
  if (kind === "font") {
    return "Font";
  }
  if (kind === "fontFile") {
    return "Font file";
  }
  if (kind === "shaderVertex") {
    return "Vertex shader";
  }
  if (kind === "shaderFragment") {
    return "Fragment shader";
  }
  return "Sound";
}

export function visitJsonWithPath(value: JsonValue, visitor: (value: JsonValue, generatedPath: string) => void, generatedPath = ""): void {
  visitor(value, generatedPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitJsonWithPath(item, visitor, appendGeneratedPath(generatedPath, String(index))));
  } else if (isJsonObject(value)) {
    Object.entries(value).forEach(([key, item]) => visitJsonWithPath(item as JsonValue, visitor, appendGeneratedPath(generatedPath, key)));
  }
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
  const mapping = findLatestMapping(unit, generatedPath, false);
  return mapping?.sourceRange;
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

export function unitRange(unit: ResourceUnit): ValidationRange {
  return unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 };
}

export function pushUnitDiagnostic(
  diagnostics: RsglCompileDiagnostic[],
  unit: ResourceUnit,
  code: string,
  message: string,
  severity: RsglCompileDiagnostic["severity"] = "error",
  generatedPath?: string
): void {
  diagnostics.push({
    code,
    message,
    severity,
    range: generatedPath === undefined
      ? unitRange(unit)
      : sourceRangeForGeneratedPath(unit, generatedPath)
  });
}

export function validateStringField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && typeof object[field] !== "string") {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a string.`);
  }
}

export interface BooleanFieldValidationOptions {
  label?: string;
  generatedPath?: string;
}

export function validateBooleanField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  options: BooleanFieldValidationOptions = {}
): void {
  if (field in object && typeof object[field] !== "boolean") {
    const label = options.label ?? "Field";
    const fieldPath = options.generatedPath === undefined
      ? undefined
      : appendGeneratedPath(options.generatedPath, field);
    pushUnitDiagnostic(diagnostics, unit, code, `${label} '${field}' must be a boolean.`, "error", fieldPath);
  }
}

export function asObject(value: unknown): Record<string, JsonValue> | null {
  return isJsonObject(value) ? value : null;
}

export { isJsonObject as isObject } from "./jsonValues";

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
