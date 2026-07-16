import {
  findItemModelSpecialSchema,
  findItemModelTintSchema,
  isItemModelSchemaEntryAvailable,
  itemModelFormatFromTarget,
  itemModelSchemaAvailabilityMessage,
  itemModelSpecialVariantsForTarget,
  type ItemModelFieldSchema
} from "../itemModelSchema";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { getItemSpecialTextureConsumer } from "./resourceReferenceConsumers";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import { requireArray, requireObject, stripMinecraftPrefix } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export function validateItemSpecial(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  validateResourceReferences = true
): void {
  const basePath = appendGeneratedPath(generatedPath, "base");
  const specialModelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.base === "string" && validateResourceReferences) {
    checkJsonResourceReference(
      model,
      "base",
      "model",
      unit,
      options,
      diagnostics,
      basePath
    );
  } else if (typeof model.base !== "string") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSpecialBase", "Item special model must define a base model id.", "error", basePath);
  }

  const specialModel = requireObject(model.model, unit, diagnostics, {
    code: "rsgl.invalidItemSpecialModel",
    message: "Item special model must define a model object.",
    generatedPath: specialModelPath
  });
  if (!specialModel) {
    return;
  }

  validateSpecialModelShape(specialModel, unit, options, diagnostics, specialModelPath);
  const texture = typeof specialModel.texture === "string" ? specialModel.texture : null;
  if (texture !== null && validateResourceReferences) {
    const consumer = getItemSpecialTextureConsumer(stripMinecraftPrefix(specialModel.type));
    if (consumer) {
      checkJsonResourceReference(
        specialModel,
        "texture",
        consumer,
        unit,
        options,
        diagnostics,
        appendGeneratedPath(specialModelPath, "texture")
      );
    }
  }
}

export function validateItemTints(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!("tints" in model)) {
    return;
  }
  const tintsPath = appendGeneratedPath(generatedPath, "tints");
  const tints = requireArray(model.tints, unit, diagnostics, {
    code: "rsgl.invalidItemTints",
    message: "Item model tints must be an array.",
    generatedPath: tintsPath
  });
  if (!tints) {
    return;
  }

  const target = itemModelFormatFromTarget(options.targetPackFormat);
  for (const [index, tint] of tints.entries()) {
    const tintPath = appendGeneratedPath(tintsPath, String(index));
    const tintObject = requireObject(tint, unit, diagnostics, {
      code: "rsgl.invalidItemTint",
      message: "Item tint must define a known tint type.",
      generatedPath: tintPath
    });
    if (!tintObject) {
      continue;
    }
    const type = stripMinecraftPrefix(tintObject.type);
    const schema = type ? findItemModelTintSchema(type) : undefined;
    if (!type || !schema) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemTint", "Item tint must define a known tint type.", "error", appendGeneratedPath(tintPath, "type"));
      continue;
    }
    if (target && !isItemModelSchemaEntryAvailable(schema, target)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.unsupportedItemTint",
        itemModelSchemaAvailabilityMessage("Item tint '" + type + "'", schema, target),
        "error",
        appendGeneratedPath(tintPath, "type")
      );
    }
    validateSchemaFields(
      tintObject,
      type,
      schema.fields,
      unit,
      diagnostics,
      tintPath,
      "Tint",
      "rsgl.missingItemTintField",
      "rsgl.invalidItemTintField",
      "rsgl.unexpectedItemTintField"
    );
  }
}

function validateSpecialModelShape(
  specialModel: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const typePath = appendGeneratedPath(generatedPath, "type");
  const type = stripMinecraftPrefix(specialModel.type);
  const schema = type ? findItemModelSpecialSchema(type) : undefined;
  if (!type || !schema) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemSpecialModelType", "Item special model must define a known special model type.", "error", typePath);
    return;
  }

  const target = itemModelFormatFromTarget(options.targetPackFormat);
  if (target && !isItemModelSchemaEntryAvailable(schema, target)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedItemSpecialModelType",
      itemModelSchemaAvailabilityMessage("Item special model type '" + type + "'", schema, target),
      "error",
      typePath
    );
  }

  const projectedVariants = itemModelSpecialVariantsForTarget(schema, target);
  const variants = projectedVariants.length > 0
    ? projectedVariants
    : itemModelSpecialVariantsForTarget(schema, undefined);
  const fields = unionSpecialFields(variants.map(variant => variant.fields));
  validateSchemaFields(
    specialModel,
    type,
    fields,
    unit,
    diagnostics,
    generatedPath,
    "Special model",
    "rsgl.missingItemSpecialModelField",
    "rsgl.invalidItemSpecialModelField",
    "rsgl.unexpectedItemSpecialModelField"
  );
}

function unionSpecialFields(
  variants: readonly (readonly ItemModelFieldSchema[])[]
): readonly ItemModelFieldSchema[] {
  const rules = new Map<string, ItemModelFieldSchema>();
  const requiredCounts = new Map<string, number>();
  for (const fields of variants) {
    for (const rule of fields) {
      if (!rules.has(rule.name)) {
        rules.set(rule.name, rule);
      }
      if (rule.required) {
        requiredCounts.set(rule.name, (requiredCounts.get(rule.name) ?? 0) + 1);
      }
    }
  }
  return [...rules.values()].map(rule => ({
    ...rule,
    required: (requiredCounts.get(rule.name) ?? 0) === variants.length
  }));
}

function validateSchemaFields(
  object: Record<string, JsonValue>,
  type: string,
  fields: readonly ItemModelFieldSchema[],
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  label: string,
  missingCode: string,
  invalidCode: string,
  unexpectedCode: string
): void {
  const allowedFields = new Set(["type", ...fields.map(rule => rule.name)]);
  for (const key of Object.keys(object)) {
    if (allowedFields.has(key)) {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      unexpectedCode,
      label + " '" + type + "' does not support field '" + key + "'.",
      "error",
      appendGeneratedPath(generatedPath, key)
    );
  }
  for (const rule of fields) {
    if (rule.required && !Object.hasOwn(object, rule.name)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        missingCode,
        label + " '" + type + "' must define '" + rule.name + "'.",
        "error",
        appendGeneratedPath(generatedPath, rule.name)
      );
      continue;
    }
    if (!Object.hasOwn(object, rule.name) || isSchemaFieldValue(rule, object[rule.name])) {
      continue;
    }
    const code = rule.kind === "color" ? "rsgl.invalidItemTintColor" : invalidCode;
    pushUnitDiagnostic(
      diagnostics,
      unit,
      code,
      schemaFieldMessage(label, type, rule),
      "error",
      appendGeneratedPath(generatedPath, rule.name)
    );
  }
}

function isSchemaFieldValue(rule: ItemModelFieldSchema, value: JsonValue): boolean {
  if (rule.kind === "json") {
    return true;
  }
  if (rule.kind === "boolean") {
    return typeof value === "boolean";
  }
  if (rule.kind === "string" || rule.kind === "resourceId") {
    return typeof value === "string";
  }
  if (rule.kind === "enum") {
    const normalized = stripMinecraftPrefix(value);
    return normalized !== null && (rule.values ?? []).includes(normalized);
  }
  if (rule.kind === "integer") {
    return Number.isInteger(value);
  }
  if (rule.kind === "nonNegativeInteger") {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }
  if (rule.kind === "finiteNumber") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (rule.kind === "positiveNumber") {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }
  if (rule.kind === "numberInUnitRange") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  }
  return isColorValue(value);
}

function schemaFieldMessage(
  label: string,
  type: string,
  rule: ItemModelFieldSchema
): string {
  if (rule.kind === "color") {
    return label + " '" + type + "' field '" + rule.name + "' must be a signed 32-bit packed color integer or RGB triplet.";
  }
  if (rule.kind === "numberInUnitRange") {
    return label + " '" + type + "' field '" + rule.name + "' must be a number between 0 and 1.";
  }
  if (rule.kind === "enum") {
    return label + " '" + type + "' field '" + rule.name + "' has an invalid value.";
  }
  return label + " '" + type + "' field '" + rule.name + "' has an invalid value.";
}

function isColorValue(value: JsonValue | undefined): boolean {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= -0x80000000 && value <= 0x7fffffff;
  }
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1);
}
