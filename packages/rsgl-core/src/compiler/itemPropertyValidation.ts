import {
  compareItemModelFormats,
  findItemModelPropertySchema,
  isItemModelSchemaEntryAvailable,
  itemModelFormatFromTarget,
  itemModelClauseObjectSchemas,
  itemModelPropertySchemas,
  itemModelSchemaAvailabilityMessage,
  projectItemModelSchemaVariants,
  type ItemModelFormat,
  type ItemModelClauseObjectSchema,
  type ItemModelFieldSchema,
  type ItemModelPropertySchema
} from "../itemModelSchema";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { parseResourceId as parseStrictResourceId } from "./resourceIds";
import { appendGeneratedPath } from "./sourcePaths";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import { requireArray, requireObject, stripMinecraftPrefix } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export type ValidateNestedItemModel = (
  value: JsonValue | undefined,
  generatedPath: string
) => void;

type ItemPropertyFamily = keyof typeof itemModelPropertySchemas;

export function validateItemRangeDispatch(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
): void {
  validateItemPropertySchema(model, "range_dispatch", unit, options, diagnostics, generatedPath);
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
    for (const [index, entry] of entries.entries()) {
      const entryPath = appendGeneratedPath(entriesPath, String(index));
      const entryObject = requireObject(entry, unit, diagnostics, {
        code: "rsgl.invalidItemRangeEntry",
        message: "Item range_dispatch entries must be objects.",
        generatedPath: entryPath
      });
      if (!entryObject) {
        continue;
      }
      validateClosedClauseObject(
        entryObject,
        itemModelClauseObjectSchemas.rangeEntry,
        unit,
        diagnostics,
        entryPath,
        "rsgl.unexpectedItemRangeEntryField",
        { threshold: "rsgl.invalidItemRangeThreshold" }
      );
      const thresholdPath = appendGeneratedPath(entryPath, "threshold");
      if ("threshold" in entryObject && (typeof entryObject.threshold !== "number" || !Number.isFinite(entryObject.threshold))) {
        pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemRangeThreshold", "Item range_dispatch entry threshold must be a finite number.", "error", thresholdPath);
      }
      if ("model" in entryObject) {
        validateNestedItemModel(entryObject.model, appendGeneratedPath(entryPath, "model"));
      }
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
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
): void {
  const propertySchema = validateItemPropertySchema(model, "select", unit, options, diagnostics, generatedPath);
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
        message: "Item select cases must be objects.",
        generatedPath: casePath
      });
      if (!caseObject) {
        continue;
      }
      validateClosedClauseObject(
        caseObject,
        itemModelClauseObjectSchemas.selectCase,
        unit,
        diagnostics,
        casePath,
        "rsgl.unexpectedItemSelectCaseField",
        { when: "rsgl.invalidItemSelectCase" }
      );
      if ("when" in caseObject) {
        validateItemSelectCaseWhen(
          property,
          propertySchema,
          caseObject.when,
          itemModelFormatFromTarget(options.targetPackFormat),
          unit,
          diagnostics,
          appendGeneratedPath(casePath, "when")
        );
      }
      if ("model" in caseObject) {
        validateNestedItemModel(caseObject.model, appendGeneratedPath(casePath, "model"));
      }
    }
  }

  if (!("fallback" in model)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.itemModelMissingFallback", "Item select should define a fallback model.", "warning", generatedPath);
  } else {
    validateNestedItemModel(model.fallback, appendGeneratedPath(generatedPath, "fallback"));
  }
}

function validateClosedClauseObject(
  object: Record<string, JsonValue>,
  schema: ItemModelClauseObjectSchema,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  unexpectedCode: string,
  missingCodes: Readonly<Record<string, string>> = {}
): void {
  const allowedFields = new Set(schema.fields.map(rule => rule.name));
  for (const key of Object.keys(object)) {
    if (allowedFields.has(key)) {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      unexpectedCode,
      "Item " + schema.name + " does not support field '" + key + "'.",
      "error",
      appendGeneratedPath(generatedPath, key)
    );
  }
  for (const rule of schema.fields) {
    if (!rule.required || Object.hasOwn(object, rule.name)) {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      missingCodes[rule.name] ?? "rsgl.missingItemModelClauseField",
      "Item " + schema.name + " must define '" + rule.name + "'.",
      "error",
      appendGeneratedPath(generatedPath, rule.name)
    );
  }
}

export function validateItemCondition(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateNestedItemModel: ValidateNestedItemModel
): void {
  validateItemPropertySchema(model, "condition", unit, options, diagnostics, generatedPath);
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

function validateItemPropertySchema(
  model: Record<string, JsonValue>,
  familyName: ItemPropertyFamily,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): ItemModelPropertySchema | undefined {
  const propertyPath = appendGeneratedPath(generatedPath, "property");
  const property = stripMinecraftPrefix(model.property);
  const schema = property ? findItemModelPropertySchema(familyName, property) : undefined;
  if (!property || !schema) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemProperty",
      "Item " + familyName + " model must define a known property.",
      "error",
      propertyPath
    );
    return undefined;
  }

  const target = itemModelFormatFromTarget(options.targetPackFormat);
  if (target && !isItemModelSchemaEntryAvailable(schema, target)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedItemProperty",
      itemModelSchemaAvailabilityMessage("Item " + familyName + " property '" + property + "'", schema, target),
      "error",
      propertyPath
    );
  }

  const family = itemModelPropertySchemas[familyName];
  const propertyRules = [...family.commonFields, ...schema.fields];
  const projectedRules = target
    ? propertyRules.filter(rule => isItemModelSchemaEntryAvailable(rule, target))
    : propertyRules;
  const allowedRuleGroups = groupItemPropertyRules(projectedRules);
  for (const [fieldName, rules] of allowedRuleGroups) {
    if (isRequiredItemPropertyField(rules, schema, target) && !(fieldName in model)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.missingItemPropertyField",
        "Item " + familyName + " property '" + property + "' must define '" + fieldName + "'.",
        "error",
        propertyPath
      );
    }
    if (Object.hasOwn(model, fieldName)) {
      validateItemPropertyFieldRules(rules, model[fieldName], unit, diagnostics, generatedPath);
    }
  }

  const propertyRuleGroups = groupItemPropertyRules(propertyRules);
  const knownRuleGroups = groupItemPropertyRules(
    family.properties.flatMap(candidate => candidate.fields).concat(family.commonFields)
  );
  const allowedFieldNames = new Set(allowedRuleGroups.keys());
  for (const [fieldName, rules] of knownRuleGroups) {
    if (!Object.hasOwn(model, fieldName) || allowedFieldNames.has(fieldName)) {
      continue;
    }
    if (propertyRuleGroups.has(fieldName)) {
      const lifecycle = rulesForAvailabilityMessage(propertyRuleGroups.get(fieldName)!);
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.unsupportedItemPropertyField",
        target
          ? itemModelSchemaAvailabilityMessage(
            "Item " + familyName + " property field '" + fieldName + "'",
            lifecycle,
            target
          )
          : "Item " + familyName + " property field '" + fieldName + "' is not available.",
        "error",
        appendGeneratedPath(generatedPath, fieldName)
      );
      validateItemPropertyFieldRules(rules, model[fieldName], unit, diagnostics, generatedPath);
      continue;
    }
    const rule = rules[0];
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unexpectedItemPropertyField",
      "Item " + familyName + " property '" + property + "' does not support field '" + fieldName + "'.",
      "error",
      appendGeneratedPath(generatedPath, fieldName)
    );
    validateItemPropertyField(rule, model[fieldName], unit, diagnostics, generatedPath);
  }
  return schema;
}

function groupItemPropertyRules(
  rules: readonly ItemModelFieldSchema[]
): Map<string, ItemModelFieldSchema[]> {
  const groups = new Map<string, ItemModelFieldSchema[]>();
  for (const rule of rules) {
    const existing = groups.get(rule.name) ?? [];
    existing.push(rule);
    groups.set(rule.name, existing);
  }
  return groups;
}

function isRequiredItemPropertyField(
  rules: readonly ItemModelFieldSchema[],
  property: ItemModelPropertySchema,
  target: ItemModelFormat | undefined
): boolean {
  if (target) {
    return rules.some(rule => rule.required);
  }
  if (!rules.every(rule => rule.required)) {
    return false;
  }
  const propertyStart = property.introduced ?? [0, 0];
  const sorted = [...rules].sort((left, right) =>
    compareLifecycleStart(left, right)
  );
  let coveredUntil: ItemModelFormat | undefined = propertyStart;
  for (const rule of sorted) {
    const introduced = rule.introduced ?? propertyStart;
    if (coveredUntil && compareItemModelFormats(introduced, coveredUntil) > 0) {
      return false;
    }
    if (!rule.removed) {
      return true;
    }
    if (!coveredUntil || compareItemModelFormats(rule.removed, coveredUntil) > 0) {
      coveredUntil = rule.removed;
    }
  }
  return false;
}

function compareLifecycleStart(
  left: ItemModelFieldSchema,
  right: ItemModelFieldSchema
): number {
  return compareItemModelFormats(left.introduced ?? [0, 0], right.introduced ?? [0, 0]);
}

function rulesForAvailabilityMessage(
  rules: readonly ItemModelFieldSchema[]
): { introduced?: ItemModelFormat; removed?: ItemModelFormat } {
  const introduced = rules
    .map(rule => rule.introduced)
    .filter((value): value is ItemModelFormat => value !== undefined)
    .sort(compareItemModelFormats)[0];
  const hasUnboundedRule = rules.some(rule => !rule.removed);
  const removed = hasUnboundedRule
    ? undefined
    : rules
      .map(rule => rule.removed)
      .filter((value): value is ItemModelFormat => value !== undefined)
      .sort(compareItemModelFormats)
      .at(-1);
  return { introduced, removed };
}

function validateItemPropertyFieldRules(
  rules: readonly ItemModelFieldSchema[],
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const defaultNamespace = unit.id?.namespace ?? "minecraft";
  if (rules.some(rule => itemPropertyFieldMessage(rule, value, defaultNamespace) === null)) {
    return;
  }
  validateItemPropertyField(rules[0], value, unit, diagnostics, generatedPath);
}

function validateItemPropertyField(
  rule: ItemModelFieldSchema,
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const message = itemPropertyFieldMessage(rule, value, unit.id?.namespace ?? "minecraft");
  if (!message) {
    return;
  }
  pushUnitDiagnostic(
    diagnostics,
    unit,
    "rsgl.invalidItemPropertyField",
    message,
    "error",
    appendGeneratedPath(generatedPath, rule.name)
  );
}

function itemPropertyFieldMessage(
  rule: ItemModelFieldSchema,
  value: JsonValue,
  defaultNamespace: string
): string | null {
  if (rule.kind === "json") {
    return null;
  }
  if (rule.kind === "boolean") {
    return typeof value === "boolean" ? null : "Field '" + rule.name + "' must be a boolean.";
  }
  if (rule.kind === "string") {
    return typeof value === "string" ? null : "Field '" + rule.name + "' must be a string.";
  }
  if (rule.kind === "resourceId") {
    if (typeof value !== "string") {
      return "Field '" + rule.name + "' must be a resource id string.";
    }
    return parseStrictResourceId(value, defaultNamespace)
      ? null
      : "Field '" + rule.name + "' must be a valid resource id.";
  }
  if (rule.kind === "nonNegativeInteger") {
    return Number.isSafeInteger(value) && Number(value) >= 0
      ? null
      : "Field '" + rule.name + "' must be a non-negative integer.";
  }
  if (rule.kind === "finiteNumber") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : "Field '" + rule.name + "' must be a finite number.";
  }
  if (rule.kind === "positiveNumber") {
    return typeof value === "number" && Number.isFinite(value) && Number(value) > 0
      ? null
      : "Field '" + rule.name + "' must be a positive number.";
  }
  const normalized = stripMinecraftPrefix(value);
  return normalized && (rule.values ?? []).includes(normalized)
    ? null
    : "Field '" + rule.name + "' has an invalid value.";
}

function validateItemSelectCaseWhen(
  property: string | null,
  schema: ItemModelPropertySchema | undefined,
  value: JsonValue,
  target: ItemModelFormat | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!property || !schema || !schema.whenValueKind || schema.whenValueKind === "json") {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  if (schema.whenValueKind === "resourceId") {
    const namespace = unit.id?.namespace ?? "minecraft";
    if (values.some(item => typeof item !== "string" || !parseStrictResourceId(item, namespace))) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidItemSelectWhenValue",
        "Item select property '" + property + "' case values must be resource ids.",
        "error",
        generatedPath
      );
    }
    return;
  }
  const whenValues = schema.whenVariants
    ? projectItemModelSchemaVariants(schema.whenVariants, target)
      .flatMap(variant => variant.values)
    : schema.whenValues ?? [];
  if (values.some(item => {
    const normalized = stripMinecraftPrefix(item);
    return !normalized || !whenValues.includes(normalized);
  })) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemSelectWhenValue",
      "Item select property '" + property + "' has an invalid case value.",
      "error",
      generatedPath
    );
  }
}
