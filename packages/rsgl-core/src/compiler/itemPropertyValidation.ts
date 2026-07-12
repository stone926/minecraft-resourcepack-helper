import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { parseResourceId as parseStrictResourceId } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import { requireArray, requireObject, stripMinecraftPrefix } from "./validationPrimitives";

export type ValidateNestedItemModel = (
  value: JsonValue | undefined,
  generatedPath: string
) => void;

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

type ItemPropertyFieldKind =
  | "boolean"
  | "enum"
  | "nonNegativeInteger"
  | "number"
  | "positiveNumber"
  | "resourceId"
  | "string";

interface ItemPropertyFieldRule {
  field: string;
  kind: ItemPropertyFieldKind;
  values?: string[];
}

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

export function validateItemRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
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
  const entries = requireArray(model.entries, unit, diagnostics, {
    code: "rsgl.invalidItemRangeEntries",
    message: "Item range_dispatch entries must be an array.",
    generatedPath: entriesPath
  });
  if (entries) {
    if (entries.length === 0) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.emptyItemRangeEntries", "Item range_dispatch should define at least one entry.", "warning", entriesPath);
    }
    let previousThreshold = -Infinity;
    for (const [index, entry] of entries.entries()) {
      const entryPath = appendGeneratedPath(entriesPath, String(index));
      const thresholdPath = appendGeneratedPath(entryPath, "threshold");
      const entryObject = requireObject(entry, unit, diagnostics, {
        code: "rsgl.invalidItemRangeThreshold",
        message: "Item range_dispatch entry threshold must be a finite number.",
        generatedPath: thresholdPath
      });
      if (!entryObject) {
        // The shared object primitive already emitted the range-threshold diagnostic.
      } else if (typeof entryObject.threshold !== "number" || !Number.isFinite(entryObject.threshold)) {
        pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemRangeThreshold", "Item range_dispatch entry threshold must be a finite number.", "error", thresholdPath);
      } else if (entryObject.threshold < previousThreshold) {
        pushUnitDiagnostic(diagnostics, unit, "rsgl.unsortedItemRangeThresholds", "Item range_dispatch entries should be sorted by threshold ascending.", "warning", thresholdPath);
      } else {
        previousThreshold = entryObject.threshold;
      }
      validateNestedItemModel(entryObject?.model, appendGeneratedPath(entryPath, "model"));
    }
  }

  if (!("fallback" in model)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.itemModelMissingFallback", "Item range_dispatch should define a fallback model.", "warning", generatedPath);
  } else {
    validateNestedItemModel(model.fallback, appendGeneratedPath(generatedPath, "fallback"));
  }
}

export function validateItemSelect(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
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
  const property = stripMinecraftPrefix(model.property);
  const casesPath = appendGeneratedPath(generatedPath, "cases");
  const cases = requireArray(model.cases, unit, diagnostics, {
    code: "rsgl.invalidItemSelectCases",
    message: "Item select cases must be an array.",
    generatedPath: casesPath
  });
  if (cases) {
    for (const [index, itemCase] of cases.entries()) {
      const casePath = appendGeneratedPath(casesPath, String(index));
      const caseObject = requireObject(itemCase, unit, diagnostics, {
        code: "rsgl.invalidItemSelectCase",
        message: "Item select cases must define a when value.",
        generatedPath: casePath
      });
      if (!caseObject) {
        // The shared object primitive already emitted the invalid-case diagnostic.
      } else if (!("when" in caseObject)) {
        pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSelectCase", "Item select cases must define a when value.", "error", casePath);
      } else {
        validateItemSelectCaseWhen(property, caseObject.when, unit, diagnostics, appendGeneratedPath(casePath, "when"));
      }
      validateNestedItemModel(caseObject?.model, appendGeneratedPath(casePath, "model"));
    }
  }

  if (!("fallback" in model)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.itemModelMissingFallback", "Item select should define a fallback model.", "warning", generatedPath);
  } else {
    validateNestedItemModel(model.fallback, appendGeneratedPath(generatedPath, "fallback"));
  }
}

export function validateItemCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
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
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemConditionBranch", "Item condition must define an on_true model.", "error", generatedPath);
  } else {
    validateNestedItemModel(model.on_true, appendGeneratedPath(generatedPath, "on_true"));
  }

  if (!("on_false" in model)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemConditionBranch", "Item condition must define an on_false model.", "error", generatedPath);
  } else {
    validateNestedItemModel(model.on_false, appendGeneratedPath(generatedPath, "on_false"));
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
    const normalized = stripMinecraftPrefix(item);
    if (!normalized || !allowedValues.includes(normalized)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSelectWhenValue", `Item select property '${property}' has an invalid case value.`, "error", generatedPath);
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
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSelectWhenValue", `Item select property '${property}' case values must be resource ids.`, "error", generatedPath);
      return;
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
  const property = stripMinecraftPrefix(model.property);
  if (!property || !knownProperties.has(property)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemProperty", `Item ${modelType} model must define a known property.`, "error", propertyPath);
    return;
  }

  for (const field of requiredFieldsByProperty.get(property) ?? []) {
    if (!(field in model)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.missingItemPropertyField", `Item ${modelType} property '${property}' must define '${field}'.`, "error", propertyPath);
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
  const property = stripMinecraftPrefix(model.property);
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
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unexpectedItemPropertyField",
      `Item ${modelType} property '${property}' does not support field '${field}'.`,
      "error",
      appendGeneratedPath(generatedPath, field)
    );
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
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidItemPropertyField",
        message,
        "error",
        appendGeneratedPath(generatedPath, rule.field)
      );
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
  const normalized = stripMinecraftPrefix(value);
  return normalized && (rule.values ?? []).includes(normalized) ? null : `Field '${rule.field}' has an invalid value.`;
}
