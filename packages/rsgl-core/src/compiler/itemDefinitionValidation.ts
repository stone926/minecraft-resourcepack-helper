import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  findItemModelNodeSchema,
  isItemModelSchemaEntryAvailable,
  itemModelFormatFromTarget,
  itemModelRootFields,
  itemModelSchemaAvailabilityMessage,
  type ItemModelNodeSchema
} from "../itemModelSchema";
import {
  validateItemCondition,
  validateItemRangeDispatch,
  validateItemSelect,
  type ValidateNestedItemModel
} from "./itemPropertyValidation";
import { validateItemSpecial, validateItemTints } from "./itemSpecialValidation";
import { validateItemTransformation } from "./itemTransformValidation";
import { findItemDefinitionHistoricalShapeIssue } from "./itemModelHistoricalShapeValidation";
import { appendGeneratedPath } from "./sourcePaths";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import {
  asObject,
  requireArray,
  requireObject,
  stripMinecraftPrefix,
  validateBooleanField
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export type ItemDefinitionValidationMode = "full" | "sourceSchema";

export function validateItemModelDefinition(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath = "",
  mode: ItemDefinitionValidationMode = "full"
): void {
  if (value === undefined) {
    // The item operation executor diagnoses a missing final producer before a
    // ResourceUnit is emitted. Keep validation focused on present values so
    // the same missing root model is not reported twice.
    return;
  }
  const model = asObject(value);
  if (!model) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemModelDefinition",
      "Item definition model must be an object.",
      "error",
      generatedPath
    );
    return;
  }

  const type = stripMinecraftPrefix(model.type);
  const schema = type ? findItemModelNodeSchema(type) : undefined;
  if (!type || !schema) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemModelType",
      "Item model definition must define a known item model type.",
      "error",
      appendGeneratedPath(generatedPath, "type")
    );
    validateNestedItemModels(model, unit, options, diagnostics, generatedPath, mode);
    return;
  }

  validateItemNodeSchema(model, schema, unit, options, diagnostics, generatedPath);
  validateItemTransformation(model, schema, unit, options, diagnostics, generatedPath);
  if (schema.allowsTints) {
    validateItemTints(model, unit, options, diagnostics, generatedPath);
  } else if ("tints" in model) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTintOwner",
      "Item model type '" + schema.name + "' does not support tints.",
      "error",
      appendGeneratedPath(generatedPath, "tints")
    );
  }

  if (type === "model") {
    validateModelReference(model, unit, options, diagnostics, generatedPath, mode);
    return;
  }

  if (type === "composite") {
    validateItemComposite(model, unit, options, diagnostics, generatedPath, mode);
    return;
  }

  const validateNestedItemModel: ValidateNestedItemModel = (nestedValue, nestedPath) => {
    validateItemModelDefinition(
      nestedValue,
      unit,
      options,
      diagnostics,
      nestedPath,
      mode
    );
  };

  if (type === "range_dispatch") {
    validateItemRangeDispatch(model, unit, options, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "select") {
    validateItemSelect(model, unit, options, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "condition") {
    validateItemCondition(model, unit, options, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "special") {
    validateItemSpecial(
      model,
      unit,
      options,
      diagnostics,
      generatedPath,
      mode === "full"
    );
    return;
  }

  if (type === "empty" || type === "bundle/selected_item") {
    return;
  }

}

export function validateItemTopLevelFields(
  content: Record<string, JsonValue> | null,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!content) {
    return;
  }
  const allowedFields = new Set(itemModelRootFields.map(field => field.name));
  for (const field of Object.keys(content)) {
    if (allowedFields.has(field)) {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unexpectedItemTopLevelField",
      "Item definitions do not support top-level field '" + field + "'.",
      "error",
      appendGeneratedPath(generatedPath, field)
    );
  }
  if (!options.targetPackFormat) {
    const issue = findItemDefinitionHistoricalShapeIssue(content, generatedPath);
    if (issue) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.incompatibleHistoricalItemModelShape",
        issue.message,
        "error",
        issue.generatedPath
      );
    }
  }
  const target = itemModelFormatFromTarget(options.targetPackFormat);
  for (const field of itemModelRootFields) {
    if (field.name === "model" || !Object.hasOwn(content, field.name)) {
      continue;
    }
    if (target && !isItemModelSchemaEntryAvailable(field, target)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.unsupportedItemFeature",
        itemModelSchemaAvailabilityMessage("Item root field '" + field.name + "'", field, target),
        "error",
        appendGeneratedPath(generatedPath, field.name)
      );
    }
  }
  validateBooleanField(content, "hand_animation_on_swap", "rsgl.invalidItemTopLevelField", unit, diagnostics, { generatedPath });
  validateBooleanField(content, "oversized_in_gui", "rsgl.invalidItemTopLevelField", unit, diagnostics, { generatedPath });
  if ("swap_animation_scale" in content && (typeof content.swap_animation_scale !== "number" || !Number.isFinite(content.swap_animation_scale))) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTopLevelField",
      "Item top-level field 'swap_animation_scale' must be a finite number.",
      "error",
      appendGeneratedPath(generatedPath, "swap_animation_scale")
    );
  }
}

function validateItemNodeSchema(
  model: Record<string, JsonValue>,
  schema: ItemModelNodeSchema,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const target = itemModelFormatFromTarget(options.targetPackFormat);
  if (target && !isItemModelSchemaEntryAvailable(schema, target)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedItemModelType",
      itemModelSchemaAvailabilityMessage("Item model type '" + schema.name + "'", schema, target),
      "error",
      appendGeneratedPath(generatedPath, "type")
    );
  }
  const allowedFields = new Set(schema.allowedFields);
  for (const field of Object.keys(model)) {
    if (allowedFields.has(field) || field === "tints" || field === "transformation") {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unexpectedItemModelField",
      "Item model type '" + schema.name + "' does not support field '" + field + "'.",
      "error",
      appendGeneratedPath(generatedPath, field)
    );
  }
}

function validateModelReference(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  mode: ItemDefinitionValidationMode
): void {
  const modelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.model === "string") {
    if (mode === "full") {
      checkJsonResourceReference(
        model,
        "model",
        "model",
        unit,
        options,
        diagnostics,
        modelPath
      );
    }
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemModelReference", "Item model definition must reference a model id.", "error", modelPath);
}

function validateItemComposite(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  mode: ItemDefinitionValidationMode
): void {
  const modelsPath = appendGeneratedPath(generatedPath, "models");
  const models = requireArray(model.models, unit, diagnostics, {
    code: "rsgl.invalidItemCompositeModels",
    message: "Item composite model must define a models array.",
    generatedPath: modelsPath
  });
  if (!models) {
    return;
  }
  if (models.length === 0) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.emptyItemCompositeModels", "Item composite model should define at least one child model.", "warning", modelsPath);
  }
  for (const [index, nested] of models.entries()) {
    const childPath = appendGeneratedPath(modelsPath, String(index));
    const child = requireObject(nested, unit, diagnostics, {
      code: "rsgl.invalidItemCompositeModel",
      message: "Item composite children must be item model objects.",
      generatedPath: childPath
    });
    if (!child) {
      continue;
    }
    validateItemModelDefinition(
      child,
      unit,
      options,
      diagnostics,
      childPath,
      mode
    );
  }
}

function validateNestedItemModels(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string,
  mode: ItemDefinitionValidationMode
): void {
  const type = stripMinecraftPrefix(model.type);
  if (type && !findItemModelNodeSchema(type)) {
    return;
  }
  if (Array.isArray(model.models)) {
    const modelsPath = appendGeneratedPath(generatedPath, "models");
    for (const [index, nested] of model.models.entries()) {
      validateItemModelDefinition(
        nested,
        unit,
        options,
        diagnostics,
        appendGeneratedPath(modelsPath, String(index)),
        mode
      );
    }
  }
  if ("fallback" in model) {
    validateItemModelDefinition(
      model.fallback,
      unit,
      options,
      diagnostics,
      appendGeneratedPath(generatedPath, "fallback"),
      mode
    );
  }
}
