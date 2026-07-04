import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { validateMcmetaAnimation } from "./mcmetaValidation";
import { validateModelStructure } from "./modelStructureValidation";

export type RsglResourceExistenceKind = "model" | "texture" | "textureDirectory" | "sound";
export type RsglResourceContentKind = "model";

export interface RsglTextureMetadata {
  width: number;
  height: number;
}

type TextureVariableResolution =
  | { kind: "resolved"; texture: string }
  | { kind: "missing" }
  | { kind: "cycle" };

interface ModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
}

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: RsglResourceExistenceKind, id: string) => boolean;
  resourceContent?: (kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  textureMetadata?: (id: string) => RsglTextureMetadata | null | undefined;
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
  const modelResolver = createModelResolver(generatedModels, options);

  for (const unit of units) {
    const diagnosticStart = diagnostics.length;
    if (unit.kind === "model") {
      validateModelUnit(unit, generatedModels, modelResolver, options, diagnostics);
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
    attachSourceFile(diagnostics, diagnosticStart, unit.sourceMap.mappings[0]?.sourceFile);
  }

  return diagnostics;
}

function attachSourceFile(diagnostics: RsglCompileDiagnostic[], start: number, fileName: string | undefined): void {
  if (!fileName) {
    return;
  }
  for (const diagnostic of diagnostics.slice(start)) {
    diagnostic.fileName ??= fileName;
  }
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
  modelResolver: (id: string) => ModelDocument | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateModelParentChain(unit, modelResolver, generatedModels, options, diagnostics);

  const content = asObject(unit.content);
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

  validateModelTextureVariables(unit, modelResolver, generatedModels, options, diagnostics);
  validateModelStructure(unit, diagnostics);
}

function validateModelParentChain(
  unit: ResourceUnit,
  modelResolver: (id: string) => ModelDocument | undefined,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const seen = new Set<string>();
  let current: ModelDocument | undefined = root;
  while (current) {
    if (seen.has(current.id)) {
      diagnostics.push({
        code: "rsgl.modelParentCycle",
        message: `Model parent chain contains a cycle at ${current.id}.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      return;
    }
    seen.add(current.id);

    const parent = current.content.parent;
    if (typeof parent !== "string") {
      return;
    }
    const parentId = qualifyResourceId(parent, current.namespace);
    current = modelResolver(parentId);
    if (!current) {
      checkResourceExists("model", parentId, unit, generatedModels, options, diagnostics);
    }
  }
}

function validateModelTextureVariables(
  unit: ResourceUnit,
  modelResolver: (id: string) => ModelDocument | undefined,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const checked = new Set<string>();
  visitJson(unit.content, value => {
    const reference = textureVariableReference(value);
    if (!reference || checked.has(reference)) {
      return;
    }
    checked.add(reference);

    const resolution = resolveTextureVariable(root, reference, modelResolver, new Set());
    if (resolution.kind === "missing") {
      diagnostics.push({
        code: "rsgl.unresolvedTextureVariable",
        message: `Texture variable '#${reference}' is not defined in the model parent chain.`,
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
  const content = asObject(unit.content);
  const variants = asObject(content?.variants);
  if (variants) {
    for (const [key, value] of Object.entries(variants)) {
      validateBlockstateVariantKey(key, unit, diagnostics);
      validateBlockstateModelProps(value, unit, generatedModels, options, diagnostics);
    }
  }

  const multipart = Array.isArray(content?.multipart) ? content.multipart : [];
  for (const entry of multipart) {
    const multipartEntry = asObject(entry);
    validateBlockstateWhen(multipartEntry?.when, unit, diagnostics);
    validateBlockstateModelProps(multipartEntry?.apply, unit, generatedModels, options, diagnostics);
  }
}

function validateBlockstateVariantKey(
  key: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (key === "") {
    return;
  }
  const seen = new Set<string>();
  for (const part of key.split(",")) {
    const separatorIndex = part.indexOf("=");
    const stateName = separatorIndex >= 0 ? part.slice(0, separatorIndex) : "";
    const stateValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
    if (!stateName || !stateValue || separatorIndex !== part.lastIndexOf("=")) {
      diagnostics.push({
        code: "rsgl.invalidBlockstateVariantKey",
        message: `Blockstate variant key '${key}' must use comma-separated state=value pairs.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      continue;
    }
    if (seen.has(stateName)) {
      diagnostics.push({
        code: "rsgl.duplicateBlockstateVariantProperty",
        message: `Blockstate variant key '${key}' defines '${stateName}' more than once.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    seen.add(stateName);
  }
}

function validateBlockstateModelProps(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateBlockstateModelProps(item, unit, generatedModels, options, diagnostics);
    }
    return;
  }

  const model = asObject(value);
  if (!model) {
    return;
  }
  if (typeof model.model === "string") {
    checkResourceExists("model", model.model, unit, generatedModels, options, diagnostics);
  }
  for (const axis of ["x", "y", "z"]) {
    validateBlockstateRotation(axis, model[axis], unit, diagnostics);
  }
  if ("z" in model && options.targetPackFormat && options.targetPackFormat.major < 75) {
    diagnostics.push({
      code: "rsgl.unsupportedBlockstateZRotation",
      message: "Blockstate z rotation requires pack format 75.0 or newer.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
  if ("uvlock" in model && typeof model.uvlock !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidBlockstateUvlock",
      message: "Blockstate model uvlock must be a boolean.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
  if ("weight" in model && (!Number.isInteger(model.weight) || Number(model.weight) <= 0)) {
    diagnostics.push({
      code: "rsgl.invalidRandomWeight",
      message: "Random model weight must be a positive integer.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateBlockstateRotation(
  axis: string,
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined || value === 0 || value === 90 || value === 180 || value === 270) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateRotation",
    message: `Blockstate model ${axis} rotation must be one of 0, 90, 180, or 270.`,
    severity: "error",
    range: unit.sourceMap.mappings[0].sourceRange
  });
}

function validateBlockstateWhen(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      diagnostics.push({
        code: "rsgl.emptyBlockstateWhen",
        message: "Blockstate multipart when array must contain at least one condition.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    for (const item of value) {
      validateBlockstateCondition(item, unit, diagnostics);
    }
    return;
  }
  validateBlockstateCondition(value, unit, diagnostics);
}

function validateBlockstateCondition(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const condition = asObject(value);
  if (!condition || Object.keys(condition).length === 0) {
    diagnostics.push({
      code: "rsgl.invalidBlockstateWhen",
      message: "Blockstate multipart when condition must be a non-empty object.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }

  const logicalKeys = ["OR", "AND"].filter(key => key in condition);
  if (logicalKeys.length > 0 && Object.keys(condition).some(key => key !== "OR" && key !== "AND")) {
    diagnostics.push({
      code: "rsgl.mixedBlockstateWhenCondition",
      message: "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same condition object.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }

  for (const key of logicalKeys) {
    const nested = condition[key];
    if (!Array.isArray(nested) || nested.length === 0) {
      diagnostics.push({
        code: "rsgl.invalidBlockstateLogicalCondition",
        message: `Blockstate multipart ${key} condition must be a non-empty condition array.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      continue;
    }
    for (const item of nested) {
      validateBlockstateCondition(item, unit, diagnostics);
    }
  }

  for (const [key, item] of Object.entries(condition)) {
    if (key === "OR" || key === "AND") {
      continue;
    }
    validateBlockstateConditionValue(item, unit, diagnostics);
  }
}

function validateBlockstateConditionValue(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value === "string" && /^!?[^|]+(?:\|!?[^|]+)*$/.test(value)) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateWhenValue",
    message: "Blockstate multipart when values must be boolean, number, or a non-empty string list separated by '|'.",
    severity: "error",
    range: unit.sourceMap.mappings[0].sourceRange
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

  if (type === "condition") {
    validateItemCondition(model, unit, generatedModels, options, diagnostics);
    return;
  }

  if (type === "special") {
    validateItemSpecial(model, unit, generatedModels, options, diagnostics);
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

function validateItemCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!("on_true" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_true model.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model["on_true"], unit, generatedModels, options, diagnostics);
  }

  if (!("on_false" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_false model.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model["on_false"], unit, generatedModels, options, diagnostics);
  }
}

function validateItemSpecial(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (typeof model.base === "string") {
    checkResourceExists("model", model.base, unit, generatedModels, options, diagnostics);
  } else {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialBase",
      message: "Item special model must define a base model id.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }

  const specialModel = asObject(model.model);
  if (!specialModel) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModel",
      message: "Item special model must define a model object.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }

  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture) {
    const target = itemSpecialTextureId(itemModelType(specialModel.type), texture, unit.id?.namespace ?? "minecraft");
    if (target) {
      checkResourceExists("texture", target, unit, generatedModels, options, diagnostics);
    }
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

function itemSpecialTextureId(type: string | null, texture: string, defaultNamespace: string): string | null {
  if (type === "chest") {
    return textureIdInFolder(texture, defaultNamespace, "entity/chest");
  }
  if (type === "shulker_box") {
    return textureIdInFolder(texture, defaultNamespace, "entity/shulker");
  }
  if (type === "head") {
    return textureIdInFolder(texture, defaultNamespace, "entity");
  }
  if (type === "copper_golem_statue") {
    const id = parseResourceId(texture, defaultNamespace);
    return `${id.namespace}:${id.path.replace(/^textures\//, "").replace(/\.png$/, "")}`;
  }
  return null;
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
  validateMcmetaAnimation(unit, textureId, options, diagnostics);
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
  kind: RsglResourceExistenceKind,
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

function createModelResolver(
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions
): (id: string) => ModelDocument | undefined {
  const generatedDocuments = new Map<string, ModelDocument>();
  const externalDocuments = new Map<string, ModelDocument | null>();

  return id => {
    const generated = generatedModels.get(id);
    if (generated) {
      let document = generatedDocuments.get(id);
      if (!document) {
        document = modelDocumentFromUnit(generated);
        if (!document) {
          return undefined;
        }
        generatedDocuments.set(id, document);
      }
      return document;
    }

    if (!options.resourceContent) {
      return undefined;
    }
    if (!externalDocuments.has(id)) {
      const content = options.resourceContent("model", id);
      const contentObject = asObject(content);
      externalDocuments.set(id, contentObject ? modelDocumentFromContent(id, contentObject) : null);
    }
    return externalDocuments.get(id) ?? undefined;
  };
}

function modelDocumentFromUnit(unit: ResourceUnit): ModelDocument | undefined {
  const id = modelKey(unit);
  const content = asObject(unit.content);
  return id && content ? modelDocumentFromContent(id, content) : undefined;
}

function modelDocumentFromContent(id: string, content: Record<string, JsonValue>): ModelDocument {
  return {
    id,
    namespace: parseResourceId(id, "minecraft").namespace,
    content
  };
}

function resolveTextureVariable(
  model: ModelDocument,
  name: string,
  modelResolver: (id: string) => ModelDocument | undefined,
  seen: Set<string>
): TextureVariableResolution {
  const resolutionKey = `${model.id}#${name}`;
  if (seen.has(resolutionKey)) {
    return { kind: "cycle" };
  }
  seen.add(resolutionKey);

  const content = model.content;
  const textures = asObject(content.textures);
  if (textures && Object.hasOwn(textures, name)) {
    return resolveTextureValue(textures[name], model, modelResolver, seen);
  }

  const parent = content.parent;
  const parentModel = typeof parent === "string"
    ? modelResolver(qualifyResourceId(parent, model.namespace))
    : undefined;
  return parentModel ? resolveTextureVariable(parentModel, name, modelResolver, seen) : { kind: "missing" };
}

function resolveTextureValue(
  value: JsonValue | undefined,
  model: ModelDocument,
  modelResolver: (id: string) => ModelDocument | undefined,
  seen: Set<string>
): TextureVariableResolution {
  if (typeof value === "string") {
    return value.startsWith("#")
      ? resolveTextureVariable(model, value.slice(1), modelResolver, seen)
      : { kind: "resolved", texture: value };
  }

  const object = asObject(value);
  if (typeof object?.sprite === "string") {
    return object.sprite.startsWith("#")
      ? resolveTextureVariable(model, object.sprite.slice(1), modelResolver, seen)
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

function resourceNotFoundCode(kind: RsglResourceExistenceKind): string {
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

function resourceLabel(kind: RsglResourceExistenceKind): string {
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
