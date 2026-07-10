import { ExternalResourceKind, JsonValue, ResourceId, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { RsglBlockstateSchema } from "./blockstateStateValidation";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

const virtualVanillaBuiltinModelPrefix = "minecraft:builtin/";

export type RsglResourceExistenceKind = ExternalResourceKind | "texture" | "textureDirectory" | "sound" | "font" | "fontFile" | "shaderVertex" | "shaderFragment";
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

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: RsglResourceExistenceKind, id: string) => boolean;
  resourceContent?: (kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  textureMetadata?: (id: string) => RsglTextureMetadata | null | undefined;
  soundMetadata?: (id: string) => RsglSoundMetadata | null | undefined;
  blockstateSchema?: (id: ResourceId) => RsglBlockstateSchema | null | undefined;
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
  range: ValidationRange = unitRange(unit)
): void {
  if (kind === "model" && generatedModels?.has(id)) {
    return;
  }
  if (kind === "model" && isVirtualBuiltinModelId(id)) {
    return;
  }
  if (!options.resourceExists || options.resourceExists(kind, id)) {
    return;
  }

  diagnostics.push({
    code: resourceNotFoundCode(kind),
    message: `${resourceLabel(kind)} not found: ${id}`,
    severity: "warning",
    range
  });
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
