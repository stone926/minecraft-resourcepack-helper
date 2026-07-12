import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  validateItemCondition,
  validateItemRangeDispatch,
  validateItemSelect,
  type ValidateNestedItemModel
} from "./itemPropertyValidation";
import { validateItemSpecial, validateItemTints } from "./itemSpecialValidation";
import { validateItemTransformation } from "./itemTransformValidation";
import { appendGeneratedPath } from "./sourcePaths";
import { checkResourceExists } from "./resourceReferenceValidation";
import { pushUnitDiagnostic, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import {
  asObject,
  requireArray,
  requireObject,
  stripMinecraftPrefix,
  validateBooleanField
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

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
  const type = stripMinecraftPrefix(model.type);
  if (type === "model") {
    validateModelReference(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "composite") {
    validateItemComposite(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  const validateNestedItemModel: ValidateNestedItemModel = (nestedValue, nestedPath) => {
    validateItemModelDefinition(
      nestedValue,
      unit,
      generatedModels,
      options,
      diagnostics,
      nestedPath
    );
  };

  if (type === "range_dispatch") {
    validateItemRangeDispatch(model, unit, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "select") {
    validateItemSelect(model, unit, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "condition") {
    validateItemCondition(model, unit, diagnostics, generatedPath, validateNestedItemModel);
    return;
  }

  if (type === "special") {
    validateItemSpecial(model, unit, generatedModels, options, diagnostics, generatedPath);
    return;
  }

  if (type === "empty" || type === "bundle/selected_item") {
    return;
  }

  pushUnitDiagnostic(
    diagnostics,
    unit,
    "rsgl.invalidItemModelType",
    "Item model definition must define a known item model type.",
    "error",
    appendGeneratedPath(generatedPath, "type")
  );
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

function validateModelReference(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const modelPath = appendGeneratedPath(generatedPath, "model");
  if (typeof model.model === "string") {
    checkResourceExists(
      "model",
      model.model,
      unit,
      generatedModels,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, modelPath)
    );
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidItemModelReference", "Item model definition must reference a model id.", "error", modelPath);
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
      generatedModels,
      options,
      diagnostics,
      childPath
    );
  }
}

function validateNestedItemModels(
  model: Record<string, JsonValue>,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const type = stripMinecraftPrefix(model.type);
  if (type && !itemModelTypes.has(type)) {
    return;
  }
  if (Array.isArray(model.models)) {
    const modelsPath = appendGeneratedPath(generatedPath, "models");
    for (const [index, nested] of model.models.entries()) {
      validateItemModelDefinition(
        nested,
        unit,
        generatedModels,
        options,
        diagnostics,
        appendGeneratedPath(modelsPath, String(index))
      );
    }
  }
  if ("fallback" in model) {
    validateItemModelDefinition(
      model.fallback,
      unit,
      generatedModels,
      options,
      diagnostics,
      appendGeneratedPath(generatedPath, "fallback")
    );
  }
}
