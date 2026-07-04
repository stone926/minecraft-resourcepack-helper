import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

type ResourceExistenceKind = "model" | "texture" | "sound";

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: ResourceExistenceKind, id: string) => boolean;
}

export function validateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const generatedModels = new Set(
    units
      .filter(unit => unit.kind === "model" && unit.id)
      .map(unit => `${unit.id!.namespace}:${unit.id!.path}`)
  );

  for (const unit of units) {
    if (unit.kind === "model") {
      validateModelUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "blockstate") {
      validateBlockstateUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "sounds") {
      validateSoundsUnit(unit, options, diagnostics);
    } else if (unit.kind === "atlas") {
      validateAtlasUnit(unit, options, diagnostics);
    } else if (unit.kind === "mcmeta") {
      validateMcmetaUnit(unit, options, diagnostics);
    } else if (unit.kind === "pack") {
      validatePackUnit(unit, options, diagnostics);
    }
  }

  return diagnostics;
}

function validateModelUnit(
  unit: ResourceUnit,
  generatedModels: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const parent = content ? content.parent : undefined;
  if (typeof parent === "string") {
    checkResourceExists("model", parent, unit, generatedModels, options, diagnostics);
  }

  const textures = asObject(content?.textures);
  if (textures) {
    for (const value of Object.values(textures)) {
      if (typeof value === "string" && !value.startsWith("#")) {
        checkResourceExists("texture", value, unit, generatedModels, options, diagnostics);
      } else if (isObject(value) && typeof value.sprite === "string" && !value.sprite.startsWith("#")) {
        checkResourceExists("texture", value.sprite, unit, generatedModels, options, diagnostics);
      }
    }
  }
}

function validateBlockstateUnit(
  unit: ResourceUnit,
  generatedModels: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  visitJson(unit.content, value => {
    if (!isObject(value)) {
      return;
    }
    if (typeof value.model === "string") {
      checkResourceExists("model", value.model, unit, generatedModels, options, diagnostics);
    }
    if ("z" in value && options.targetPackFormat && options.targetPackFormat.major < 75) {
      diagnostics.push({
        code: "rsgl.unsupportedBlockstateZRotation",
        message: "Blockstate z rotation requires pack format 75.0 or newer.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    if ("weight" in value && (!Number.isInteger(value.weight) || Number(value.weight) <= 0)) {
      diagnostics.push({
        code: "rsgl.invalidRandomWeight",
        message: "Random model weight must be a positive integer.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  });
}

function validateSoundsUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  for (const event of Object.values(content)) {
    const eventObject = asObject(event);
    const sounds = Array.isArray(eventObject?.sounds) ? eventObject.sounds : [];
    for (const sound of sounds) {
      const soundId = soundReferenceId(sound, namespace);
      if (soundId) {
        checkResourceExists("sound", soundId, unit, undefined, options, diagnostics);
      }
    }
  }
}

function validateAtlasUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const sources = Array.isArray(content?.sources) ? content.sources : [];
  for (const source of sources) {
    const sourceObject = asObject(source);
    if (!sourceObject) {
      continue;
    }
    if (sourceObject.type === "single" && typeof sourceObject.resource === "string") {
      checkResourceExists("texture", sourceObject.resource, unit, undefined, options, diagnostics);
    }
    if (sourceObject.type === "paletted_permutations") {
      for (const texture of stringValues(sourceObject.textures)) {
        checkResourceExists("texture", texture, unit, undefined, options, diagnostics);
      }
      for (const texture of Object.values(asObject(sourceObject.permutations) ?? {})) {
        if (typeof texture === "string") {
          checkResourceExists("texture", texture, unit, undefined, options, diagnostics);
        }
      }
    }
  }
}

function validateMcmetaUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const textureId = textureIdFromMcmetaOutputPath(unit.outputPath);
  if (textureId) {
    checkResourceExists("texture", textureId, unit, undefined, options, diagnostics);
  }
}

function validatePackUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const entries = Array.isArray(asObject(content?.overlays)?.entries)
    ? asObject(content?.overlays)?.entries as JsonValue[]
    : [];
  for (const entry of entries) {
    const overlay = asObject(entry);
    if (!overlay) {
      continue;
    }
    if (typeof overlay.directory === "string" && !/^[a-z0-9_-]+$/.test(overlay.directory)) {
      diagnostics.push({
        code: "rsgl.invalidOverlayDirectory",
        message: `Overlay directory '${overlay.directory}' must contain only lowercase letters, numbers, '_' or '-'.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    validateOverlayRange(overlay, unit, options, diagnostics);
  }
}

function checkResourceExists(
  kind: ResourceExistenceKind,
  id: string,
  unit: ResourceUnit,
  generatedModels: Set<string> | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (kind === "model" && generatedModels?.has(id)) {
    return;
  }
  if (!options.resourceExists || options.resourceExists(kind, id)) {
    return;
  }

  diagnostics.push({
    code: resourceNotFoundCode(kind),
    message: `${resourceLabel(kind)} not found: ${id}`,
    severity: "warning",
    range: unit.sourceMap.mappings[0].sourceRange
  });
}

function soundReferenceId(value: JsonValue, defaultNamespace: string): string | null {
  if (typeof value === "string") {
    return qualifyResourceId(value, defaultNamespace);
  }
  const object = asObject(value);
  if (!object || typeof object.name !== "string" || object.type === "event") {
    return null;
  }
  return qualifyResourceId(object.name, defaultNamespace);
}

function textureIdFromMcmetaOutputPath(outputPath: string): string | null {
  const match = /^assets\/([^/]+)\/textures\/(.+)\.png\.mcmeta$/.exec(outputPath.replace(/\\/g, "/"));
  return match ? `${match[1]}:${match[2]}` : null;
}

function qualifyResourceId(value: string, defaultNamespace: string): string {
  return value.includes(":") ? value : `${defaultNamespace}:${value}`;
}

function stringValues(value: JsonValue | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function validateOverlayRange(
  overlay: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const min = packFormatValue(overlay.min_format);
  const max = packFormatValue(overlay.max_format);
  const hasCompleteRange = min !== null && max !== null;
  const hasValidRange = hasCompleteRange && comparePackFormats(min, max) <= 0;
  if (hasCompleteRange && !hasValidRange) {
    diagnostics.push({
      code: "rsgl.invalidOverlayFormatRange",
      message: "Overlay min_format must not be greater than max_format.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
  const target = options.targetPackFormat ? [options.targetPackFormat.major, options.targetPackFormat.minor ?? 0] as const : null;
  if (target && hasValidRange && (comparePackFormats(target, min) < 0 || comparePackFormats(target, max) > 0)) {
    diagnostics.push({
      code: "rsgl.overlayOutsideTargetFormat",
      message: "Overlay format range does not include the compile target pack format.",
      severity: "warning",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function packFormatValue(value: JsonValue | undefined): readonly [number, number] | null {
  if (typeof value === "number") {
    return [value, 0];
  }
  if (Array.isArray(value) && typeof value[0] === "number") {
    return [value[0], typeof value[1] === "number" ? value[1] : 0];
  }
  return null;
}

function comparePackFormats(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function resourceNotFoundCode(kind: ResourceExistenceKind): string {
  if (kind === "model") {
    return "rsgl.modelNotFound";
  }
  if (kind === "texture") {
    return "rsgl.textureNotFound";
  }
  return "rsgl.soundNotFound";
}

function resourceLabel(kind: ResourceExistenceKind): string {
  if (kind === "model") {
    return "Model";
  }
  if (kind === "texture") {
    return "Texture";
  }
  return "Sound";
}

function visitJson(value: JsonValue, visitor: (value: JsonValue) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => visitJson(item, visitor));
  } else if (isObject(value)) {
    Object.values(value).forEach(item => visitJson(item as JsonValue, visitor));
  }
}

function asObject(value: unknown): Record<string, JsonValue> | null {
  return isObject(value) ? value as Record<string, JsonValue> : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
