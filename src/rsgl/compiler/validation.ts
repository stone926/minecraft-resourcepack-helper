import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

type ResourceExistenceKind = "model" | "texture" | "textureDirectory" | "sound";

type TextureVariableResolution =
  | { kind: "resolved"; texture: string }
  | { kind: "missing" }
  | { kind: "cycle" };

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: ResourceExistenceKind, id: string) => boolean;
}

export function validateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const generatedModels = new Map(
    units
      .filter(unit => unit.kind === "model" && unit.id)
      .map(unit => [`${unit.id!.namespace}:${unit.id!.path}`, unit])
  );

  for (const unit of units) {
    if (unit.kind === "model") {
      validateModelUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "item") {
      validateItemUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "blockstate") {
      validateBlockstateUnit(unit, generatedModels, options, diagnostics);
    } else if (unit.kind === "sounds") {
      validateSoundsUnit(unit, options, diagnostics);
    } else if (unit.kind === "atlas") {
      validateAtlasUnit(unit, options, diagnostics);
    } else if (unit.kind === "mcmeta") {
      validateMcmetaUnit(unit, options, diagnostics);
    } else if (unit.kind === "particles") {
      validateParticlesUnit(unit, options, diagnostics);
    } else if (unit.kind === "equipment") {
      validateEquipmentUnit(unit, options, diagnostics);
    } else if (unit.kind === "pack") {
      validatePackUnit(unit, options, diagnostics);
    }
  }

  return diagnostics;
}

function validateItemUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateItemModelDefinition(asObject(unit.content)?.model, unit, generatedModels, options, diagnostics);
}

function validateModelUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateGeneratedModelParentChain(unit, generatedModels, diagnostics);

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

  validateModelTextureVariables(unit, generatedModels, options, diagnostics);
  validateModelElements(unit, diagnostics);
}

function validateModelElements(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const elements = asObject(unit.content)?.elements;
  if (!Array.isArray(elements)) {
    return;
  }

  for (const element of elements) {
    const elementObject = asObject(element);
    if (!elementObject) {
      continue;
    }
    validateModelElementVector(elementObject.from, "from", unit, diagnostics);
    validateModelElementVector(elementObject.to, "to", unit, diagnostics);
    validateModelElementFaces(asObject(elementObject.faces), unit, diagnostics);
  }
}

function validateModelElementVector(
  value: JsonValue | undefined,
  name: "from" | "to",
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
    diagnostics.push({
      code: "rsgl.invalidModelElementVector",
      message: `Model element '${name}' must be a finite [x, y, z] number vector.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }
  if (value.some(item => Number(item) < -16 || Number(item) > 32)) {
    diagnostics.push({
      code: "rsgl.modelElementCoordinateOutOfRange",
      message: `Model element '${name}' coordinates must be between -16 and 32.`,
      severity: "warning",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateModelElementFaces(
  faces: Record<string, JsonValue> | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!faces) {
    return;
  }
  for (const face of Object.values(faces)) {
    const faceObject = asObject(face);
    if (!faceObject) {
      continue;
    }
    if ("texture" in faceObject && (typeof faceObject.texture !== "string" || !faceObject.texture.startsWith("#"))) {
      diagnostics.push({
        code: "rsgl.invalidModelFaceTexture",
        message: "Model element face texture must reference a texture variable starting with '#'.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    if ("rotation" in faceObject && !isValidFaceRotation(faceObject.rotation)) {
      diagnostics.push({
        code: "rsgl.invalidModelFaceRotation",
        message: "Model element face rotation must be one of 0, 90, 180, or 270.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }
}

function isValidFaceRotation(value: JsonValue | undefined): boolean {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function validateGeneratedModelParentChain(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const seen = new Set<string>();
  let current: ResourceUnit | undefined = unit;
  while (current) {
    const key = modelKey(current);
    if (!key) {
      return;
    }
    if (seen.has(key)) {
      diagnostics.push({
        code: "rsgl.modelParentCycle",
        message: `Generated model parent chain contains a cycle at ${key}.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      return;
    }
    seen.add(key);

    const parent = asObject(current.content)?.parent;
    if (typeof parent !== "string") {
      return;
    }
    current = generatedModels.get(qualifyResourceId(parent, current.id?.namespace ?? "minecraft"));
  }
}

function validateModelTextureVariables(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const checked = new Set<string>();
  visitJson(unit.content, value => {
    const reference = textureVariableReference(value);
    if (!reference || checked.has(reference)) {
      return;
    }
    checked.add(reference);

    const resolution = resolveTextureVariable(unit, reference, generatedModels, new Set());
    if (resolution.kind === "missing") {
      diagnostics.push({
        code: "rsgl.unresolvedTextureVariable",
        message: `Texture variable '#${reference}' is not defined in the generated model parent chain.`,
        severity: "warning",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    } else if (resolution.kind === "cycle") {
      diagnostics.push({
        code: "rsgl.textureVariableCycle",
        message: `Texture variable '#${reference}' resolves through a cycle.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    } else {
      checkResourceExists("texture", resolution.texture, unit, generatedModels, options, diagnostics);
    }
  });
}

function validateBlockstateUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
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

function validateItemModelDefinition(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const model = asObject(value);
  if (!model) {
    return;
  }

  const type = itemModelType(model.type);
  if (type === "model") {
    if (typeof model.model === "string") {
      checkResourceExists("model", model.model, unit, generatedModels, options, diagnostics);
    }
    return;
  }

  if (type === "range_dispatch") {
    validateItemRangeDispatch(model, unit, generatedModels, options, diagnostics);
    return;
  }

  if (type === "select") {
    validateItemSelect(model, unit, generatedModels, options, diagnostics);
    return;
  }

  validateNestedItemModels(model, unit, generatedModels, options, diagnostics);
}

function validateItemRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const entries = Array.isArray(model.entries) ? model.entries : null;
  if (!entries) {
    diagnostics.push({
      code: "rsgl.invalidItemRangeEntries",
      message: "Item range_dispatch entries must be an array.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    let previousThreshold = -Infinity;
    for (const entry of entries) {
      const entryObject = asObject(entry);
      if (!entryObject || typeof entryObject.threshold !== "number" || !Number.isFinite(entryObject.threshold)) {
        diagnostics.push({
          code: "rsgl.invalidItemRangeThreshold",
          message: "Item range_dispatch entry threshold must be a finite number.",
          severity: "error",
          range: unit.sourceMap.mappings[0].sourceRange
        });
      } else if (entryObject.threshold < previousThreshold) {
        diagnostics.push({
          code: "rsgl.unsortedItemRangeThresholds",
          message: "Item range_dispatch entries should be sorted by threshold ascending.",
          severity: "warning",
          range: unit.sourceMap.mappings[0].sourceRange
        });
      } else {
        previousThreshold = entryObject.threshold;
      }
      validateItemModelDefinition(entryObject?.model, unit, generatedModels, options, diagnostics);
    }
  }

  if (!("fallback" in model)) {
    diagnostics.push({
      code: "rsgl.itemModelMissingFallback",
      message: "Item range_dispatch should define a fallback model.",
      severity: "warning",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics);
  }
}

function validateItemSelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const cases = Array.isArray(model.cases) ? model.cases : null;
  if (!cases) {
    diagnostics.push({
      code: "rsgl.invalidItemSelectCases",
      message: "Item select cases must be an array.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    for (const itemCase of cases) {
      const caseObject = asObject(itemCase);
      if (!caseObject || !("when" in caseObject)) {
        diagnostics.push({
          code: "rsgl.invalidItemSelectCase",
          message: "Item select cases must define a when value.",
          severity: "error",
          range: unit.sourceMap.mappings[0].sourceRange
        });
      }
      validateItemModelDefinition(caseObject?.model, unit, generatedModels, options, diagnostics);
    }
  }

  if (!("fallback" in model)) {
    diagnostics.push({
      code: "rsgl.itemModelMissingFallback",
      message: "Item select should define a fallback model.",
      severity: "warning",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics);
  }
}

function validateNestedItemModels(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (Array.isArray(model.models)) {
    for (const nested of model.models) {
      validateItemModelDefinition(nested, unit, generatedModels, options, diagnostics);
    }
  }
  if ("fallback" in model) {
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics);
  }
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
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  const sources = Array.isArray(content?.sources) ? content.sources : [];
  for (const source of sources) {
    const sourceObject = asObject(source);
    if (!sourceObject) {
      continue;
    }
    const sourceType = atlasSourceType(sourceObject.type);
    if (sourceType === "directory" && typeof sourceObject.source === "string") {
      checkResourceExists("textureDirectory", qualifyResourceId(sourceObject.source, namespace), unit, undefined, options, diagnostics);
    }
    if ((sourceType === "single" || sourceType === "unstitch") && typeof sourceObject.resource === "string") {
      checkResourceExists("texture", qualifyResourceId(sourceObject.resource, namespace), unit, undefined, options, diagnostics);
    }
    if (sourceType === "filter") {
      validateAtlasFilterPattern(sourceObject, unit, diagnostics);
    }
    if (sourceType === "paletted_permutations") {
      for (const texture of stringValues(sourceObject.textures)) {
        checkResourceExists("texture", qualifyResourceId(texture, namespace), unit, undefined, options, diagnostics);
      }
      if (typeof sourceObject.palette_key === "string") {
        checkResourceExists("texture", qualifyResourceId(sourceObject.palette_key, namespace), unit, undefined, options, diagnostics);
      }
      for (const texture of Object.values(asObject(sourceObject.permutations) ?? {})) {
        if (typeof texture === "string") {
          checkResourceExists("texture", qualifyResourceId(texture, namespace), unit, undefined, options, diagnostics);
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

function validateParticlesUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  const textures = Array.isArray(content?.textures) ? content.textures : [];
  for (const texture of textures) {
    if (typeof texture === "string") {
      checkResourceExists("texture", textureIdInFolder(texture, namespace, "particle"), unit, undefined, options, diagnostics);
    }
  }
}

function validateEquipmentUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  const layers = asObject(content?.layers);
  if (!layers) {
    return;
  }

  for (const [layerName, layerEntries] of Object.entries(layers)) {
    if (!Array.isArray(layerEntries)) {
      continue;
    }
    for (const layerEntry of layerEntries) {
      const texture = asObject(layerEntry)?.texture;
      if (typeof texture === "string") {
        checkResourceExists("texture", textureIdInFolder(texture, namespace, `entity/equipment/${layerName}`), unit, undefined, options, diagnostics);
      }
    }
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
  generatedModels: Map<string, ResourceUnit> | undefined,
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

function resolveTextureVariable(
  unit: ResourceUnit,
  name: string,
  generatedModels: Map<string, ResourceUnit>,
  seen: Set<string>
): TextureVariableResolution {
  const key = modelKey(unit);
  const resolutionKey = `${key ?? unit.outputPath}#${name}`;
  if (seen.has(resolutionKey)) {
    return { kind: "cycle" };
  }
  seen.add(resolutionKey);

  const content = asObject(unit.content);
  const textures = asObject(content?.textures);
  if (textures && Object.hasOwn(textures, name)) {
    return resolveTextureValue(textures[name], unit, generatedModels, seen);
  }

  const parent = content?.parent;
  const parentUnit = typeof parent === "string"
    ? generatedModels.get(qualifyResourceId(parent, unit.id?.namespace ?? "minecraft"))
    : undefined;
  return parentUnit ? resolveTextureVariable(parentUnit, name, generatedModels, seen) : { kind: "missing" };
}

function resolveTextureValue(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  seen: Set<string>
): TextureVariableResolution {
  if (typeof value === "string") {
    return value.startsWith("#")
      ? resolveTextureVariable(unit, value.slice(1), generatedModels, seen)
      : { kind: "resolved", texture: value };
  }

  const object = asObject(value);
  if (typeof object?.sprite === "string") {
    return object.sprite.startsWith("#")
      ? resolveTextureVariable(unit, object.sprite.slice(1), generatedModels, seen)
      : { kind: "resolved", texture: object.sprite };
  }

  return { kind: "missing" };
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

function atlasSourceType(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

function itemModelType(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

function validateAtlasFilterPattern(
  sourceObject: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const pattern = asObject(sourceObject.pattern);
  if (!pattern) {
    return;
  }
  for (const key of ["namespace", "path"]) {
    const value = pattern[key];
    if (typeof value !== "string") {
      continue;
    }
    try {
      new RegExp(value);
    } catch {
      diagnostics.push({
        code: "rsgl.invalidAtlasFilterPattern",
        message: `Atlas filter ${key} pattern is not a valid regular expression.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }
}

function textureVariableReference(value: JsonValue): string | null {
  return typeof value === "string" && value.startsWith("#") && value.length > 1
    ? value.slice(1)
    : null;
}

function modelKey(unit: ResourceUnit): string | null {
  return unit.id ? `${unit.id.namespace}:${unit.id.path}` : null;
}

function qualifyResourceId(value: string, defaultNamespace: string): string {
  return value.includes(":") ? value : `${defaultNamespace}:${value}`;
}

function textureIdInFolder(value: string, defaultNamespace: string, folder: string): string {
  const id = parseResourceId(value, defaultNamespace);
  const path = id.path.startsWith(`${folder}/`) ? id.path : `${folder}/${id.path}`;
  return `${id.namespace}:${path}`;
}

function parseResourceId(value: string, defaultNamespace: string): { namespace: string; path: string } {
  const separator = value.indexOf(":");
  return separator >= 0
    ? { namespace: value.slice(0, separator), path: value.slice(separator + 1) }
    : { namespace: defaultNamespace, path: value };
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
  if (kind === "textureDirectory") {
    return "rsgl.textureDirectoryNotFound";
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
  if (kind === "textureDirectory") {
    return "Texture directory";
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
