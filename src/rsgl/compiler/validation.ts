import { JsonValue, ResourceId, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { validateFontMetadata } from "./fontValidation";
import { validateBlockstateStateDomains, type RsglBlockstateSchema } from "./blockstateStateValidation";
import { validateLangMetadata, validateSoundsMetadata } from "./langSoundsValidation";
import { validateMcmetaAnimation } from "./mcmetaValidation";
import { validateModelStructure } from "./modelStructureValidation";
import { validatePackMetadata } from "./packMetadataValidation";
import { validatePostEffectMetadata } from "./postEffectValidation";
import { parseResourceId as parseStrictResourceId } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { validateWaypointStyleMetadata } from "./waypointStyleValidation";

export type RsglResourceExistenceKind = "model" | "texture" | "textureDirectory" | "sound" | "font" | "fontFile" | "shaderVertex" | "shaderFragment";
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

type TextureVariableResolution =
  | { kind: "resolved"; texture: string }
  | { kind: "missing" }
  | { kind: "cycle" };

type ValidationRange = RsglCompileDiagnostic["range"];

interface ModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
}

const specialModelRequiredFields = new Map<string, string[]>([
  ["banner", ["color"]],
  ["bell", []],
  ["book", ["open_angle", "page1", "page2"]],
  ["chest", ["texture"]],
  ["conduit", []],
  ["copper_golem_statue", ["pose", "texture"]],
  ["decorated_pot", []],
  ["end_cube", ["effect"]],
  ["head", ["kind"]],
  ["player_head", []],
  ["shield", []],
  ["shulker_box", ["texture"]],
  ["trident", []]
]);

const specialModelEnumFields = new Map<string, Array<{ field: string; values: string[] }>>([
  ["banner", [
    { field: "attachment", values: ["ground", "wall"] },
    { field: "color", values: ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"] }
  ]],
  ["chest", [
    { field: "chest_type", values: ["single", "left", "right"] }
  ]],
  ["copper_golem_statue", [
    { field: "pose", values: ["standing", "sitting", "running", "star"] }
  ]],
  ["end_cube", [
    { field: "effect", values: ["gateway", "portal"] }
  ]],
  ["head", [
    { field: "kind", values: ["skeleton", "wither_skeleton", "player", "zombie", "creeper", "piglin", "dragon"] }
  ]]
]);

const specialModelStringFields = new Map<string, string[]>([
  ["chest", ["texture"]],
  ["copper_golem_statue", ["texture"]],
  ["head", ["texture"]],
  ["shulker_box", ["texture"]]
]);

const itemTintRequiredFields = new Map<string, string[]>([
  ["constant", ["value"]],
  ["dye", ["default"]],
  ["firework", ["default"]],
  ["grass", ["temperature", "downfall"]],
  ["map_color", ["default"]],
  ["potion", ["default"]],
  ["team", ["default"]],
  ["custom_model_data", ["default"]]
]);

const conditionProperties = new Set([
  "broken",
  "bundle/has_selected_item",
  "carried",
  "component",
  "custom_model_data",
  "damaged",
  "extended_view",
  "fishing_rod/cast",
  "has_component",
  "keybind_down",
  "selected",
  "using_item",
  "view_entity"
]);

const conditionRequiredFields = new Map<string, string[]>([
  ["component", ["predicate", "value"]],
  ["has_component", ["component"]],
  ["keybind_down", ["keybind"]]
]);

const selectProperties = new Set([
  "block_state",
  "charge_type",
  "component",
  "context_dimension",
  "context_entity_type",
  "custom_model_data",
  "display_context",
  "local_time",
  "main_hand",
  "potion_contents",
  "trim_material"
]);

const selectRequiredFields = new Map<string, string[]>([
  ["block_state", ["block_state_property"]],
  ["component", ["component"]],
  ["local_time", ["pattern"]]
]);

const selectWhenValueDomains = new Map<string, string[]>([
  ["main_hand", ["left", "right"]],
  ["charge_type", ["none", "arrow", "rocket", "firework", "firework_rocket"]],
  ["display_context", [
    "none",
    "thirdperson_lefthand",
    "thirdperson_righthand",
    "firstperson_lefthand",
    "firstperson_righthand",
    "head",
    "gui",
    "ground",
    "fixed"
  ]]
]);

const selectWhenResourceIdProperties = new Set([
  "context_dimension",
  "context_entity_type",
  "potion_contents",
  "trim_material"
]);

const rangeDispatchProperties = new Set([
  "bundle/fullness",
  "compass",
  "cooldown",
  "count",
  "crossbow/pull",
  "custom_model_data",
  "damage",
  "time",
  "use_cycle",
  "use_duration"
]);

const itemModelTypes = new Set([
  "model",
  "composite",
  "condition",
  "select",
  "range_dispatch",
  "empty",
  "bundle/selected_item",
  "special"
]);

const rangeDispatchRequiredFields = new Map<string, string[]>([
  ["compass", ["target"]],
  ["time", ["source"]]
]);

export interface RsglResourceValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
  resourceExists?: (kind: RsglResourceExistenceKind, id: string) => boolean;
  resourceContent?: (kind: RsglResourceContentKind, id: string) => JsonValue | null | undefined;
  textureMetadata?: (id: string) => RsglTextureMetadata | null | undefined;
  soundMetadata?: (id: string) => RsglSoundMetadata | null | undefined;
  blockstateSchema?: (id: ResourceId) => RsglBlockstateSchema | null | undefined;
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
  const generatedFonts = new Set(
    units
      .filter(unit => unit.kind === "font" && unit.id)
      .map(unit => `${unit.id!.namespace}:${unit.id!.path}`)
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
    } else if (unit.kind === "lang") {
      validateLangUnit(unit, diagnostics);
    } else if (unit.kind === "atlas") {
      validateAtlasUnit(unit, options, diagnostics);
    } else if (unit.kind === "mcmeta") {
      validateMcmetaUnit(unit, options, diagnostics);
    } else if (unit.kind === "particles") {
      validateParticlesUnit(unit, options, diagnostics);
    } else if (unit.kind === "equipment") {
      validateEquipmentUnit(unit, options, diagnostics);
    } else if (unit.kind === "font") {
      validateFontUnit(unit, generatedFonts, options, diagnostics);
    } else if (unit.kind === "waypoint_style") {
      validateWaypointStyleUnit(unit, options, diagnostics);
    } else if (unit.kind === "post_effect") {
      validatePostEffectUnit(unit, options, diagnostics);
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
  const content = asObject(unit.content);
  validateItemTopLevelFields(content, unit, diagnostics);
  validateItemModelDefinition(content?.model, unit, generatedModels, options, diagnostics, "/model");
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
  visitJson(unit.content as JsonValue, value => {
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
  validateBlockstateStateDomains(content ?? undefined, unit, diagnostics, {
    rangeForGeneratedPath: path => sourceRangeForGeneratedPath(unit, path),
    schema: unit.id ? options.blockstateSchema?.(unit.id) : undefined
  });
  const variants = asObject(content?.variants);
  if (variants) {
    for (const [key, value] of Object.entries(variants)) {
      const range = sourceRangeForGeneratedPath(unit, blockstateVariantPath(key));
      validateBlockstateVariantKey(key, diagnostics, range);
      validateBlockstateModelProps(value, unit, generatedModels, options, diagnostics, range);
    }
  }

  const multipart = Array.isArray(content?.multipart) ? content.multipart : [];
  for (const [index, entry] of multipart.entries()) {
    const multipartEntry = asObject(entry);
    const range = sourceRangeForGeneratedPath(unit, blockstateMultipartPath(index));
    validateBlockstateWhen(multipartEntry?.when, diagnostics, range);
    validateBlockstateModelProps(multipartEntry?.apply, unit, generatedModels, options, diagnostics, range);
  }
}

function validateBlockstateVariantKey(
  key: string,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
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
        range
      });
      continue;
    }
    if (seen.has(stateName)) {
      diagnostics.push({
        code: "rsgl.duplicateBlockstateVariantProperty",
        message: `Blockstate variant key '${key}' defines '${stateName}' more than once.`,
        severity: "error",
        range
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
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateBlockstateModelProps(item, unit, generatedModels, options, diagnostics, range);
    }
    return;
  }

  const model = asObject(value);
  if (!model) {
    return;
  }
  if (typeof model.model === "string") {
    checkResourceExists("model", model.model, unit, generatedModels, options, diagnostics, range);
  }
  for (const axis of ["x", "y", "z"]) {
    validateBlockstateRotation(axis, model[axis], diagnostics, range);
  }
  if ("z" in model && options.targetPackFormat && options.targetPackFormat.major < 75) {
    diagnostics.push({
      code: "rsgl.unsupportedBlockstateZRotation",
      message: "Blockstate z rotation requires pack format 75.0 or newer.",
      severity: "error",
      range
    });
  }
  if ("uvlock" in model && typeof model.uvlock !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidBlockstateUvlock",
      message: "Blockstate model uvlock must be a boolean.",
      severity: "error",
      range
    });
  }
  if ("weight" in model && (!Number.isInteger(model.weight) || Number(model.weight) <= 0)) {
    diagnostics.push({
      code: "rsgl.invalidRandomWeight",
      message: "Random model weight must be a positive integer.",
      severity: "error",
      range
    });
  }
}

function validateBlockstateRotation(
  axis: string,
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  if (value === undefined || value === 0 || value === 90 || value === 180 || value === 270) {
    return;
  }
  diagnostics.push({
    code: "rsgl.invalidBlockstateRotation",
    message: `Blockstate model ${axis} rotation must be one of 0, 90, 180, or 270.`,
    severity: "error",
    range
  });
}

function validateBlockstateWhen(
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
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
        range
      });
    }
    for (const item of value) {
      validateBlockstateCondition(item, diagnostics, range);
    }
    return;
  }
  validateBlockstateCondition(value, diagnostics, range);
}

function validateBlockstateCondition(
  value: JsonValue | undefined,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): void {
  const condition = asObject(value);
  if (!condition || Object.keys(condition).length === 0) {
    diagnostics.push({
      code: "rsgl.invalidBlockstateWhen",
      message: "Blockstate multipart when condition must be a non-empty object.",
      severity: "error",
      range
    });
    return;
  }

  const logicalKeys = ["OR", "AND"].filter(key => key in condition);
  if (logicalKeys.length > 0 && Object.keys(condition).some(key => key !== "OR" && key !== "AND")) {
    diagnostics.push({
      code: "rsgl.mixedBlockstateWhenCondition",
      message: "Blockstate multipart OR/AND conditions cannot be mixed with state properties in the same condition object.",
      severity: "error",
      range
    });
  }

  for (const key of logicalKeys) {
    const nested = condition[key];
    if (!Array.isArray(nested) || nested.length === 0) {
      diagnostics.push({
        code: "rsgl.invalidBlockstateLogicalCondition",
        message: `Blockstate multipart ${key} condition must be a non-empty condition array.`,
        severity: "error",
        range
      });
      continue;
    }
    for (const item of nested) {
      validateBlockstateCondition(item, diagnostics, range);
    }
  }

  for (const [key, item] of Object.entries(condition)) {
    if (key === "OR" || key === "AND") {
      continue;
    }
    validateBlockstateConditionValue(item, diagnostics, range);
  }
}

function validateBlockstateConditionValue(
  value: JsonValue,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
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
    range
  });
}

function validateItemModelDefinition(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath = ""
): void {
  const model = asObject(value);
  if (!model) {
    return;
  }

  validateItemTransformation(model, unit, diagnostics);
  validateItemTints(model, unit, diagnostics, generatedPath);
  const type = itemModelType(model.type);
  if (type === "model") {
    if (typeof model.model === "string") {
      checkResourceExists(
        "model",
        model.model,
        unit,
        generatedModels,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "model"))
      );
    } else {
      diagnostics.push({
        code: "rsgl.invalidItemModelReference",
        message: "Item model definition must reference a model id.",
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "model"))
      });
    }
    return;
  }

  if (type === "composite") {
    validateItemComposite(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "range_dispatch") {
    validateItemRangeDispatch(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "select") {
    validateItemSelect(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "condition") {
    validateItemCondition(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "special") {
    validateItemSpecial(model, unit, generatedModels, options, diagnostics);
    return;
  }

  if (type === "empty" || type === "bundle/selected_item") {
    return;
  }

  diagnostics.push({
    code: "rsgl.invalidItemModelType",
    message: "Item model definition must define a known item model type.",
    severity: "error",
    range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "type"))
  });
  validateNestedItemModels(model, unit, generatedModels, options, diagnostics, generatedPath);
}

function validateItemComposite(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const models = Array.isArray(model.models) ? model.models : null;
  if (!models) {
    diagnostics.push({
      code: "rsgl.invalidItemCompositeModels",
      message: "Item composite model must define a models array.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }
  if (models.length === 0) {
    diagnostics.push({
      code: "rsgl.emptyItemCompositeModels",
      message: "Item composite model should define at least one child model.",
      severity: "warning",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
  for (const [index, nested] of models.entries()) {
    if (!asObject(nested)) {
      diagnostics.push({
        code: "rsgl.invalidItemCompositeModel",
        message: "Item composite children must be item model objects.",
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      continue;
    }
    validateItemModelDefinition(
      nested,
      unit,
      generatedModels,
      options,
      diagnostics,
      appendGeneratedPath(appendGeneratedPath(generatedPath, "models"), String(index))
    );
  }
}

function validateItemRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  validateItemProperty(model, "range_dispatch", rangeDispatchProperties, rangeDispatchRequiredFields, unit, diagnostics);
  validateNonNegativeIntegerField(model, "index", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateBooleanField(model, "normalize", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateBooleanField(model, "wobble", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateBooleanField(model, "remaining", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validatePositiveNumberField(model, "period", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateEnumField(model, "target", ["spawn", "lodestone", "recovery", "none"], "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateEnumField(model, "source", ["daytime", "moon_phase", "random"], "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateNumberField(model, "scale", "rsgl.invalidItemPropertyField", unit, diagnostics);
  const entries = Array.isArray(model.entries) ? model.entries : null;
  if (!entries) {
    diagnostics.push({
      code: "rsgl.invalidItemRangeEntries",
      message: "Item range_dispatch entries must be an array.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    if (entries.length === 0) {
      diagnostics.push({
        code: "rsgl.emptyItemRangeEntries",
        message: "Item range_dispatch should define at least one entry.",
        severity: "warning",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
    let previousThreshold = -Infinity;
    for (const [index, entry] of entries.entries()) {
      const entryPath = appendGeneratedPath(appendGeneratedPath(generatedPath, "entries"), String(index));
      const thresholdPath = appendGeneratedPath(entryPath, "threshold");
      const entryObject = asObject(entry);
      if (!entryObject || typeof entryObject.threshold !== "number" || !Number.isFinite(entryObject.threshold)) {
        diagnostics.push({
          code: "rsgl.invalidItemRangeThreshold",
          message: "Item range_dispatch entry threshold must be a finite number.",
          severity: "error",
          range: sourceRangeForGeneratedPath(unit, thresholdPath)
        });
      } else if (entryObject.threshold < previousThreshold) {
        diagnostics.push({
          code: "rsgl.unsortedItemRangeThresholds",
          message: "Item range_dispatch entries should be sorted by threshold ascending.",
          severity: "warning",
          range: sourceRangeForGeneratedPath(unit, thresholdPath)
        });
      } else {
        previousThreshold = entryObject.threshold;
      }
      validateItemModelDefinition(
        entryObject?.model,
        unit,
        generatedModels,
        options,
        diagnostics,
        appendGeneratedPath(entryPath, "model")
      );
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
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "fallback"));
  }
}

function validateItemSelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  validateItemProperty(model, "select", selectProperties, selectRequiredFields, unit, diagnostics);
  validateStringField(model, "component", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateNonNegativeIntegerField(model, "index", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "block_state_property", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "locale", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "time_zone", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "pattern", "rsgl.invalidItemPropertyField", unit, diagnostics);
  const property = itemModelType(model.property);
  const cases = Array.isArray(model.cases) ? model.cases : null;
  if (!cases) {
    diagnostics.push({
      code: "rsgl.invalidItemSelectCases",
      message: "Item select cases must be an array.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    for (const [index, itemCase] of cases.entries()) {
      const casePath = appendGeneratedPath(appendGeneratedPath(generatedPath, "cases"), String(index));
      const caseObject = asObject(itemCase);
      if (!caseObject || !("when" in caseObject)) {
        diagnostics.push({
          code: "rsgl.invalidItemSelectCase",
          message: "Item select cases must define a when value.",
          severity: "error",
          range: sourceRangeForGeneratedPath(unit, casePath)
        });
      } else {
        validateItemSelectCaseWhen(property, caseObject.when, unit, diagnostics, appendGeneratedPath(casePath, "when"));
      }
      validateItemModelDefinition(
        caseObject?.model,
        unit,
        generatedModels,
        options,
        diagnostics,
        appendGeneratedPath(casePath, "model")
      );
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
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "fallback"));
  }
}

function validateItemSelectCaseWhen(
  property: string | null,
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!property) {
    return;
  }
  const allowedValues = selectWhenValueDomains.get(property);
  if (!allowedValues) {
    if (selectWhenResourceIdProperties.has(property)) {
      validateItemSelectCaseResourceIds(property, value, unit, diagnostics, generatedPath);
    }
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const normalized = itemModelType(item);
    if (!normalized || !allowedValues.includes(normalized)) {
      diagnostics.push({
        code: "rsgl.invalidItemSelectWhenValue",
        message: `Item select property '${property}' has an invalid case value.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, generatedPath)
      });
      return;
    }
  }
}

function validateItemSelectCaseResourceIds(
  property: string,
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const values = Array.isArray(value) ? value : [value];
  const namespace = unit.id?.namespace ?? "minecraft";
  for (const item of values) {
    if (typeof item !== "string" || !parseStrictResourceId(item, namespace)) {
      diagnostics.push({
        code: "rsgl.invalidItemSelectWhenValue",
        message: `Item select property '${property}' case values must be resource ids.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, generatedPath)
      });
      return;
    }
  }
}

function validateItemCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  validateItemProperty(model, "condition", conditionProperties, conditionRequiredFields, unit, diagnostics);
  validateStringField(model, "component", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateBooleanField(model, "ignore_default", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateNonNegativeIntegerField(model, "index", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "keybind", "rsgl.invalidItemPropertyField", unit, diagnostics);
  validateStringField(model, "predicate", "rsgl.invalidItemPropertyField", unit, diagnostics);
  if (!("on_true" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_true model.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model["on_true"], unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "on_true"));
  }

  if (!("on_false" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_false model.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  } else {
    validateItemModelDefinition(model["on_false"], unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "on_false"));
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

  validateSpecialModelShape(specialModel, unit, diagnostics);
  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture) {
    const target = itemSpecialTextureId(itemModelType(specialModel.type), texture, unit.id?.namespace ?? "minecraft");
    if (target) {
      checkResourceExists("texture", target, unit, generatedModels, options, diagnostics);
    }
  }
}

function validateItemTopLevelFields(
  content: Record<string, JsonValue> | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!content) {
    return;
  }
  validateBooleanField(content, "hand_animation_on_swap", "rsgl.invalidItemTopLevelField", unit, diagnostics);
  validateBooleanField(content, "oversized_in_gui", "rsgl.invalidItemTopLevelField", unit, diagnostics);
  if ("swap_animation_scale" in content && (typeof content.swap_animation_scale !== "number" || !Number.isFinite(content.swap_animation_scale))) {
    diagnostics.push({
      code: "rsgl.invalidItemTopLevelField",
      message: "Item top-level field 'swap_animation_scale' must be a finite number.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateItemProperty(
  model: Record<string, JsonValue>,
  modelType: string,
  knownProperties: Set<string>,
  requiredFieldsByProperty: Map<string, string[]>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const property = itemModelType(model.property);
  if (!property || !knownProperties.has(property)) {
    diagnostics.push({
      code: "rsgl.invalidItemProperty",
      message: `Item ${modelType} model must define a known property.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }

  for (const field of requiredFieldsByProperty.get(property) ?? []) {
    if (!(field in model)) {
      diagnostics.push({
        code: "rsgl.missingItemPropertyField",
        message: `Item ${modelType} property '${property}' must define '${field}'.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }
}

function validateSpecialModelShape(
  specialModel: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const type = itemModelType(specialModel.type);
  const requiredFields = type ? specialModelRequiredFields.get(type) : undefined;
  if (!type || !requiredFields) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelType",
      message: "Item special model must define a known special model type.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }

  for (const field of requiredFields) {
    if (!(field in specialModel)) {
      diagnostics.push({
        code: "rsgl.missingItemSpecialModelField",
        message: `Item special model '${type}' must define '${field}'.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }

  for (const { field, values } of specialModelEnumFields.get(type) ?? []) {
    const value = specialModel[field];
    if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
      diagnostics.push({
        code: "rsgl.invalidItemSpecialModelField",
        message: `Item special model '${type}' field '${field}' has an invalid value.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }

  for (const field of specialModelStringFields.get(type) ?? []) {
    validateStringField(specialModel, field, "rsgl.invalidItemSpecialModelField", unit, diagnostics);
  }

  validateNumberInRange(specialModel, "page1", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics);
  validateNumberInRange(specialModel, "page2", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics);
  validateNumberInRange(specialModel, "openness", 0, 1, "rsgl.invalidItemSpecialModelField", unit, diagnostics);
  validateNumberInRange(specialModel, "animation", -Infinity, Infinity, "rsgl.invalidItemSpecialModelField", unit, diagnostics);
  if ("open_angle" in specialModel && !Number.isInteger(specialModel.open_angle)) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: "Item special model 'book' field 'open_angle' must be an integer.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateItemTransformation(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!("transformation" in model)) {
    return;
  }
  const transformation = model.transformation;
  if (Array.isArray(transformation)) {
    validateNumericArray(transformation, 16, "rsgl.invalidItemTransformation", "Item transformation matrix must contain 16 numbers.", unit, diagnostics);
    return;
  }
  const object = asObject(transformation);
  if (!object) {
    diagnostics.push({
      code: "rsgl.invalidItemTransformation",
      message: "Item transformation must be a matrix array or transformation object.",
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
    return;
  }

  for (const field of ["left_rotation", "right_rotation", "scale", "translation"]) {
    if (!(field in object)) {
      diagnostics.push({
        code: "rsgl.missingItemTransformationField",
        message: `Item transformation must define '${field}'.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
    }
  }
  validateRotationValue(object.left_rotation, "left_rotation", unit, diagnostics);
  validateRotationValue(object.right_rotation, "right_rotation", unit, diagnostics);
  validateNumericArray(object.scale, 3, "rsgl.invalidItemTransformation", "Item transformation 'scale' must contain 3 numbers.", unit, diagnostics);
  validateNumericArray(object.translation, 3, "rsgl.invalidItemTransformation", "Item transformation 'translation' must contain 3 numbers.", unit, diagnostics);
}

function validateItemTints(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!("tints" in model)) {
    return;
  }
  const tintsPath = appendGeneratedPath(generatedPath, "tints");
  if (!Array.isArray(model.tints)) {
    diagnostics.push({
      code: "rsgl.invalidItemTints",
      message: "Item model tints must be an array.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, tintsPath)
    });
    return;
  }

  for (const [index, tint] of model.tints.entries()) {
    const tintPath = appendGeneratedPath(tintsPath, String(index));
    const tintObject = asObject(tint);
    const type = itemModelType(tintObject?.type);
    const requiredFields = type ? itemTintRequiredFields.get(type) : undefined;
    if (!tintObject || !type || !requiredFields) {
      diagnostics.push({
        code: "rsgl.invalidItemTint",
        message: "Item tint must define a known tint type.",
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, tintPath)
      });
      continue;
    }
    for (const field of requiredFields) {
      if (!(field in tintObject)) {
        diagnostics.push({
          code: "rsgl.missingItemTintField",
          message: `Item tint '${type}' must define '${field}'.`,
          severity: "error",
          range: sourceRangeForGeneratedPath(unit, tintPath)
        });
      }
    }
    validateTintValue(tintObject, type, unit, diagnostics, tintPath);
  }
}

function validateTintValue(
  tint: Record<string, JsonValue>,
  type: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  for (const field of ["value", "default"]) {
    if (field in tint && !isColorValue(tint[field])) {
      diagnostics.push({
        code: "rsgl.invalidItemTintColor",
        message: `Item tint '${type}' field '${field}' must be a packed color integer or RGB triplet.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
      });
    }
  }
  validateNumberInRange(tint, "temperature", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics);
  validateNumberInRange(tint, "downfall", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics);
  if ("index" in tint && (!Number.isInteger(tint.index) || Number(tint.index) < 0)) {
    diagnostics.push({
      code: "rsgl.invalidItemTintField",
      message: `Item tint '${type}' field 'index' must be a non-negative integer.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "index"))
    });
  }
}

function validateRotationValue(
  value: JsonValue | undefined,
  field: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (Array.isArray(value)) {
    validateNumericArray(value, 4, "rsgl.invalidItemTransformation", `Item transformation '${field}' quaternion must contain 4 numbers.`, unit, diagnostics);
    return;
  }
  const object = asObject(value);
  if (!object || typeof object.angle !== "number" || !Number.isFinite(object.angle) || !isNumericArray(object.axis, 3)) {
    diagnostics.push({
      code: "rsgl.invalidItemTransformation",
      message: `Item transformation '${field}' must be a quaternion or axis-angle rotation.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateBooleanField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && typeof object[field] !== "boolean") {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a boolean.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateStringField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && typeof object[field] !== "string") {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a string.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateEnumField(
  object: Record<string, JsonValue>,
  field: string,
  values: string[],
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = itemModelType(object[field]);
  if (field in object && (!value || !values.includes(value))) {
    diagnostics.push({
      code,
      message: `Field '${field}' has an invalid value.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateNonNegativeIntegerField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (!Number.isInteger(object[field]) || Number(object[field]) < 0)) {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a non-negative integer.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateNumberField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (typeof object[field] !== "number" || !Number.isFinite(object[field]))) {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a finite number.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validatePositiveNumberField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (typeof object[field] !== "number" || !Number.isFinite(object[field]) || Number(object[field]) <= 0)) {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a positive number.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateNumberInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a number${Number.isFinite(min) && Number.isFinite(max) ? ` between ${min} and ${max}` : ""}.`,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function validateNumericArray(
  value: JsonValue | undefined,
  length: number,
  code: string,
  message: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!isNumericArray(value, length)) {
    diagnostics.push({
      code,
      message,
      severity: "error",
      range: unit.sourceMap.mappings[0].sourceRange
    });
  }
}

function isNumericArray(value: JsonValue | undefined, length: number): boolean {
  return Array.isArray(value)
    && value.length === length
    && value.every(item => typeof item === "number" && Number.isFinite(item));
}

function isColorValue(value: JsonValue | undefined): boolean {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value <= 0xffffff;
  }
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}

function validateNestedItemModels(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const type = itemModelType(model.type);
  if (type && !itemModelTypes.has(type)) {
    return;
  }
  if (Array.isArray(model.models)) {
    for (const [index, nested] of model.models.entries()) {
      validateItemModelDefinition(
        nested,
        unit,
        generatedModels,
        options,
        diagnostics,
        appendGeneratedPath(appendGeneratedPath(generatedPath, "models"), String(index))
      );
    }
  }
  if ("fallback" in model) {
    validateItemModelDefinition(model.fallback, unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "fallback"));
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
  validateSoundsMetadata(unit, options, diagnostics);
}

function validateLangUnit(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateLangMetadata(unit, diagnostics);
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

function validateFontUnit(
  unit: ResourceUnit,
  generatedFonts: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateFontMetadata(unit, generatedFonts, options, diagnostics);
}

function validateWaypointStyleUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateWaypointStyleMetadata(unit, options, diagnostics);
}

function validatePostEffectUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validatePostEffectMetadata(unit, options, diagnostics);
}

function validatePackUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validatePackMetadata(unit, options, diagnostics);
}

function checkResourceExists(
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

function visitJson(value: JsonValue, visitor: (value: JsonValue) => void): void {
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => visitJson(item, visitor));
  } else if (isObject(value)) {
    Object.values(value).forEach(item => visitJson(item as JsonValue, visitor));
  }
}

function sourceRangeForGeneratedPath(unit: ResourceUnit, generatedPath: string): ValidationRange {
  return unit.sourceMap.mappings.find(mapping => mapping.generatedPath === generatedPath)?.sourceRange
    ?? unitRange(unit);
}

function blockstateVariantPath(key: string): string {
  return appendGeneratedPath("/variants", key);
}

function blockstateMultipartPath(index: number): string {
  return appendGeneratedPath("/multipart", String(index));
}

function unitRange(unit: ResourceUnit): ValidationRange {
  return unit.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 };
}

function asObject(value: unknown): Record<string, JsonValue> | null {
  return isObject(value) ? value as Record<string, JsonValue> : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
