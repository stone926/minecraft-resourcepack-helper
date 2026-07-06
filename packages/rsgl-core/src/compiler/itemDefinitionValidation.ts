import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { parseResourceId as parseStrictResourceId } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkResourceExists,
  itemModelType,
  sourceRangeForGeneratedPath,
  unitRange,
  type RsglResourceValidationOptions,
  type ValidationRange
} from "./validationShared";
import {
  minecraftResourceIdInFolder,
  qualifyMinecraftResourceId,
  tryParseMinecraftResourceId
} from "../../../mc-assets/src";

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

const conditionPropertyFields = new Map<string, string[]>([
  ["component", ["predicate", "value"]],
  ["custom_model_data", ["index"]],
  ["has_component", ["component", "ignore_default"]],
  ["keybind_down", ["keybind"]]
]);

const conditionKnownPropertyFields = new Set([
  "component",
  "ignore_default",
  "index",
  "keybind",
  "predicate",
  "value"
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

const selectPropertyFields = new Map<string, string[]>([
  ["block_state", ["block_state_property"]],
  ["component", ["component"]],
  ["custom_model_data", ["index"]],
  ["local_time", ["locale", "pattern", "time_zone"]],
  ["potion_contents", ["component"]]
]);

const selectKnownPropertyFields = new Set([
  "block_state_property",
  "component",
  "index",
  "locale",
  "pattern",
  "time_zone"
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

const rangeDispatchPropertyFields = new Map<string, string[]>([
  ["compass", ["target", "wobble"]],
  ["count", ["normalize"]],
  ["custom_model_data", ["index"]],
  ["damage", ["normalize"]],
  ["time", ["source", "wobble"]],
  ["use_cycle", ["period"]],
  ["use_duration", ["remaining"]]
]);

const rangeDispatchKnownPropertyFields = new Set([
  "index",
  "normalize",
  "period",
  "remaining",
  "source",
  "target",
  "wobble"
]);

const rangeDispatchFieldRules: ItemPropertyFieldRule[] = [
  { field: "index", kind: "nonNegativeInteger" },
  { field: "normalize", kind: "boolean" },
  { field: "period", kind: "positiveNumber" },
  { field: "remaining", kind: "boolean" },
  { field: "scale", kind: "number" },
  { field: "source", kind: "enum", values: ["daytime", "moon_phase", "random"] },
  { field: "target", kind: "enum", values: ["spawn", "lodestone", "recovery", "none"] },
  { field: "wobble", kind: "boolean" }
];

const selectFieldRules: ItemPropertyFieldRule[] = [
  { field: "block_state_property", kind: "string" },
  { field: "component", kind: "resourceId" },
  { field: "index", kind: "nonNegativeInteger" },
  { field: "locale", kind: "string" },
  { field: "pattern", kind: "string" },
  { field: "time_zone", kind: "string" }
];

const conditionFieldRules: ItemPropertyFieldRule[] = [
  { field: "component", kind: "resourceId" },
  { field: "ignore_default", kind: "boolean" },
  { field: "index", kind: "nonNegativeInteger" },
  { field: "keybind", kind: "string" },
  { field: "predicate", kind: "string" }
];

type ItemPropertyFieldKind = "boolean" | "enum" | "nonNegativeInteger" | "number" | "positiveNumber" | "resourceId" | "string";

interface ItemPropertyFieldRule {
  field: string;
  kind: ItemPropertyFieldKind;
  values?: string[];
}

export function validateItemModelDefinition(
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

  validateItemTransformation(model, unit, diagnostics, generatedPath);
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
    validateItemSpecial(model, unit, generatedModels, options, diagnostics, generatedPath);
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

export function validateItemTopLevelFields(
  content: Record<string, JsonValue> | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!content) {
    return;
  }
  validateBooleanField(content, "hand_animation_on_swap", "rsgl.invalidItemTopLevelField", unit, diagnostics, generatedPath);
  validateBooleanField(content, "oversized_in_gui", "rsgl.invalidItemTopLevelField", unit, diagnostics, generatedPath);
  if ("swap_animation_scale" in content && (typeof content.swap_animation_scale !== "number" || !Number.isFinite(content.swap_animation_scale))) {
    diagnostics.push({
      code: "rsgl.invalidItemTopLevelField",
      message: "Item top-level field 'swap_animation_scale' must be a finite number.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "swap_animation_scale"))
    });
  }
}

function validateItemComposite(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const modelsPath = appendGeneratedPath(generatedPath, "models");
  const models = Array.isArray(model.models) ? model.models : null;
  if (!models) {
    diagnostics.push({
      code: "rsgl.invalidItemCompositeModels",
      message: "Item composite model must define a models array.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, modelsPath)
    });
    return;
  }
  if (models.length === 0) {
    diagnostics.push({
      code: "rsgl.emptyItemCompositeModels",
      message: "Item composite model should define at least one child model.",
      severity: "warning",
      range: sourceRangeForGeneratedPath(unit, modelsPath)
    });
  }
  for (const [index, nested] of models.entries()) {
    const childPath = appendGeneratedPath(modelsPath, String(index));
    if (!asObject(nested)) {
      diagnostics.push({
        code: "rsgl.invalidItemCompositeModel",
        message: "Item composite children must be item model objects.",
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, childPath)
      });
      continue;
    }
    validateItemModelDefinition(
      nested,
      unit,
      generatedModels,
      options,
      diagnostics,
      childPath
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
  validateItemProperty(model, "range_dispatch", rangeDispatchProperties, rangeDispatchRequiredFields, unit, diagnostics, generatedPath);
  validateItemPropertyFields(
    model,
    "range_dispatch",
    rangeDispatchProperties,
    rangeDispatchKnownPropertyFields,
    rangeDispatchPropertyFields,
    unit,
    diagnostics,
    generatedPath
  );
  validateItemPropertyFieldTypes(model, rangeDispatchFieldRules, unit, diagnostics, generatedPath);
  const entriesPath = appendGeneratedPath(generatedPath, "entries");
  const entries = Array.isArray(model.entries) ? model.entries : null;
  if (!entries) {
    diagnostics.push({
      code: "rsgl.invalidItemRangeEntries",
      message: "Item range_dispatch entries must be an array.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, entriesPath)
    });
  } else {
    if (entries.length === 0) {
      diagnostics.push({
        code: "rsgl.emptyItemRangeEntries",
        message: "Item range_dispatch should define at least one entry.",
        severity: "warning",
        range: sourceRangeForGeneratedPath(unit, entriesPath)
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
      range: sourceRangeForGeneratedPath(unit, generatedPath)
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
  validateItemProperty(model, "select", selectProperties, selectRequiredFields, unit, diagnostics, generatedPath);
  validateItemPropertyFields(
    model,
    "select",
    selectProperties,
    selectKnownPropertyFields,
    selectPropertyFields,
    unit,
    diagnostics,
    generatedPath
  );
  validateItemPropertyFieldTypes(model, selectFieldRules, unit, diagnostics, generatedPath);
  const property = itemModelType(model.property);
  const casesPath = appendGeneratedPath(generatedPath, "cases");
  const cases = Array.isArray(model.cases) ? model.cases : null;
  if (!cases) {
    diagnostics.push({
      code: "rsgl.invalidItemSelectCases",
      message: "Item select cases must be an array.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, casesPath)
    });
  } else {
    for (const [index, itemCase] of cases.entries()) {
      const casePath = appendGeneratedPath(casesPath, String(index));
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
      range: sourceRangeForGeneratedPath(unit, generatedPath)
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
  validateItemProperty(model, "condition", conditionProperties, conditionRequiredFields, unit, diagnostics, generatedPath);
  validateItemPropertyFields(
    model,
    "condition",
    conditionProperties,
    conditionKnownPropertyFields,
    conditionPropertyFields,
    unit,
    diagnostics,
    generatedPath
  );
  validateItemPropertyFieldTypes(model, conditionFieldRules, unit, diagnostics, generatedPath);
  if (!("on_true" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_true model.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, generatedPath)
    });
  } else {
    validateItemModelDefinition(model["on_true"], unit, generatedModels, options, diagnostics, appendGeneratedPath(generatedPath, "on_true"));
  }

  if (!("on_false" in model)) {
    diagnostics.push({
      code: "rsgl.invalidItemConditionBranch",
      message: "Item condition must define an on_false model.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, generatedPath)
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
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const basePath = appendGeneratedPath(generatedPath, "base");
  const specialModelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.base === "string") {
    checkResourceExists("model", model.base, unit, generatedModels, options, diagnostics, sourceRangeForGeneratedPath(unit, basePath));
  } else {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialBase",
      message: "Item special model must define a base model id.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, basePath)
    });
  }

  const specialModel = asObject(model.model);
  if (!specialModel) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModel",
      message: "Item special model must define a model object.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, specialModelPath)
    });
    return;
  }

  validateSpecialModelShape(specialModel, unit, diagnostics, specialModelPath);
  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture) {
    const target = itemSpecialTextureId(itemModelType(specialModel.type), texture, unit.id?.namespace ?? "minecraft");
    if (target) {
      checkResourceExists(
        "texture",
        target,
        unit,
        generatedModels,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath(specialModelPath, "texture"))
      );
    }
  }
}

function validateItemProperty(
  model: Record<string, JsonValue>,
  modelType: string,
  knownProperties: Set<string>,
  requiredFieldsByProperty: Map<string, string[]>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const propertyPath = appendGeneratedPath(generatedPath, "property");
  const property = itemModelType(model.property);
  if (!property || !knownProperties.has(property)) {
    diagnostics.push({
      code: "rsgl.invalidItemProperty",
      message: `Item ${modelType} model must define a known property.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, propertyPath)
    });
    return;
  }

  for (const field of requiredFieldsByProperty.get(property) ?? []) {
    if (!(field in model)) {
      diagnostics.push({
        code: "rsgl.missingItemPropertyField",
        message: `Item ${modelType} property '${property}' must define '${field}'.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, propertyPath)
      });
    }
  }
}

function validateItemPropertyFields(
  model: Record<string, JsonValue>,
  modelType: string,
  knownProperties: Set<string>,
  knownFields: Set<string>,
  allowedFieldsByProperty: Map<string, string[]>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const property = itemModelType(model.property);
  if (!property) {
    return;
  }
  const allowedFields = new Set(allowedFieldsByProperty.get(property) ?? []);
  if (!knownProperties.has(property)) {
    return;
  }
  for (const field of knownFields) {
    if (!Object.hasOwn(model, field) || allowedFields.has(field)) {
      continue;
    }
    diagnostics.push({
      code: "rsgl.unexpectedItemPropertyField",
      message: `Item ${modelType} property '${property}' does not support field '${field}'.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateItemPropertyFieldTypes(
  model: Record<string, JsonValue>,
  rules: ItemPropertyFieldRule[],
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  for (const rule of rules) {
    if (!Object.hasOwn(model, rule.field)) {
      continue;
    }
    const value = model[rule.field];
    const message = itemPropertyFieldMessage(rule, value, unit.id?.namespace ?? "minecraft");
    if (message) {
      diagnostics.push({
        code: "rsgl.invalidItemPropertyField",
        message,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, rule.field))
      });
    }
  }
}

function itemPropertyFieldMessage(
  rule: ItemPropertyFieldRule,
  value: JsonValue,
  defaultNamespace: string
): string | null {
  if (rule.kind === "boolean") {
    return typeof value === "boolean" ? null : `Field '${rule.field}' must be a boolean.`;
  }
  if (rule.kind === "string") {
    return typeof value === "string" ? null : `Field '${rule.field}' must be a string.`;
  }
  if (rule.kind === "resourceId") {
    if (typeof value !== "string") {
      return `Field '${rule.field}' must be a resource id string.`;
    }
    return parseStrictResourceId(value, defaultNamespace) ? null : `Field '${rule.field}' must be a valid resource id.`;
  }
  if (rule.kind === "nonNegativeInteger") {
    return Number.isInteger(value) && Number(value) >= 0 ? null : `Field '${rule.field}' must be a non-negative integer.`;
  }
  if (rule.kind === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : `Field '${rule.field}' must be a finite number.`;
  }
  if (rule.kind === "positiveNumber") {
    return typeof value === "number" && Number.isFinite(value) && Number(value) > 0 ? null : `Field '${rule.field}' must be a positive number.`;
  }
  const normalized = itemModelType(value);
  return normalized && (rule.values ?? []).includes(normalized) ? null : `Field '${rule.field}' has an invalid value.`;
}

function validateSpecialModelShape(
  specialModel: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const typePath = appendGeneratedPath(generatedPath, "type");
  const type = itemModelType(specialModel.type);
  const requiredFields = type ? specialModelRequiredFields.get(type) : undefined;
  if (!type || !requiredFields) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelType",
      message: "Item special model must define a known special model type.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, typePath)
    });
    return;
  }

  for (const field of requiredFields) {
    if (!(field in specialModel)) {
      diagnostics.push({
        code: "rsgl.missingItemSpecialModelField",
        message: `Item special model '${type}' must define '${field}'.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, typePath)
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
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
      });
    }
  }

  for (const field of specialModelStringFields.get(type) ?? []) {
    validateSpecialStringField(specialModel, field, unit, diagnostics, generatedPath);
  }

  validateSpecialNumberInRange(specialModel, "page1", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "page2", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "openness", 0, 1, unit, diagnostics, generatedPath);
  validateSpecialNumberInRange(specialModel, "animation", -Infinity, Infinity, unit, diagnostics, generatedPath);
  if ("open_angle" in specialModel && !Number.isInteger(specialModel.open_angle)) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: "Item special model 'book' field 'open_angle' must be an integer.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "open_angle"))
    });
  }
}

function validateSpecialStringField(
  object: Record<string, JsonValue>,
  field: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (field in object && typeof object[field] !== "string") {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: `Field '${field}' must be a string.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateSpecialNumberInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    diagnostics.push({
      code: "rsgl.invalidItemSpecialModelField",
      message: `Field '${field}' must be a number${Number.isFinite(min) && Number.isFinite(max) ? ` between ${min} and ${max}` : ""}.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateItemTransformation(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!("transformation" in model)) {
    return;
  }
  const transformationPath = appendGeneratedPath(generatedPath, "transformation");
  const transformation = model.transformation;
  if (Array.isArray(transformation)) {
    validateNumericArray(
      transformation,
      16,
      "rsgl.invalidItemTransformation",
      "Item transformation matrix must contain 16 numbers.",
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, transformationPath)
    );
    return;
  }
  const object = asObject(transformation);
  if (!object) {
    diagnostics.push({
      code: "rsgl.invalidItemTransformation",
      message: "Item transformation must be a matrix array or transformation object.",
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, transformationPath)
    });
    return;
  }

  for (const field of ["left_rotation", "right_rotation", "scale", "translation"]) {
    if (!(field in object)) {
      diagnostics.push({
        code: "rsgl.missingItemTransformationField",
        message: `Item transformation must define '${field}'.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, transformationPath)
      });
    }
  }
  validateRotationValue(object.left_rotation, "left_rotation", unit, diagnostics, transformationPath);
  validateRotationValue(object.right_rotation, "right_rotation", unit, diagnostics, transformationPath);
  validateNumericArray(
    object.scale,
    3,
    "rsgl.invalidItemTransformation",
    "Item transformation 'scale' must contain 3 numbers.",
    unit,
    diagnostics,
    sourceRangeForGeneratedPath(unit, appendGeneratedPath(transformationPath, "scale"))
  );
  validateNumericArray(
    object.translation,
    3,
    "rsgl.invalidItemTransformation",
    "Item transformation 'translation' must contain 3 numbers.",
    unit,
    diagnostics,
    sourceRangeForGeneratedPath(unit, appendGeneratedPath(transformationPath, "translation"))
  );
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
  validateNumberInRange(tint, "temperature", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
  validateNumberInRange(tint, "downfall", 0, 1, "rsgl.invalidItemTintField", unit, diagnostics, generatedPath);
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
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const fieldPath = appendGeneratedPath(generatedPath, field);
  if (Array.isArray(value)) {
    validateNumericArray(
      value,
      4,
      "rsgl.invalidItemTransformation",
      `Item transformation '${field}' quaternion must contain 4 numbers.`,
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, fieldPath)
    );
    return;
  }
  const object = asObject(value);
  if (!object || typeof object.angle !== "number" || !Number.isFinite(object.angle) || !isNumericArray(object.axis, 3)) {
    diagnostics.push({
      code: "rsgl.invalidItemTransformation",
      message: `Item transformation '${field}' must be a quaternion or axis-angle rotation.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, fieldPath)
    });
  }
}

function validateBooleanField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (field in object && typeof object[field] !== "boolean") {
    diagnostics.push({
      code,
      message: `Field '${field}' must be a boolean.`,
      severity: "error",
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
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
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
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
      range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field))
    });
  }
}

function validateNumericArray(
  value: JsonValue | undefined,
  length: number,
  code: string,
  message: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit)
): void {
  if (!isNumericArray(value, length)) {
    diagnostics.push({
      code,
      message,
      severity: "error",
      range
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
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity/chest");
  }
  if (type === "shulker_box") {
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity/shulker");
  }
  if (type === "head") {
    return minecraftResourceIdInFolder(texture, defaultNamespace, "entity");
  }
  if (type === "copper_golem_statue") {
    const id = tryParseMinecraftResourceId(texture, defaultNamespace);
    return id ? `${id.namespace}:${id.path.replace(/^textures\//, "").replace(/\.png$/, "")}` : qualifyMinecraftResourceId(texture, defaultNamespace);
  }
  return null;
}
