import {
  ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT,
  isItemModelSchemaEntryAvailable,
  itemModelFormatFromTarget,
  itemModelSchemaAvailabilityMessage,
  type ItemModelNodeSchema
} from "../itemModelSchema";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { pushDiagnosticAtRange, pushUnitDiagnostic, sourceRangeForGeneratedPath, unitRange } from "./validationDiagnostics";
import { requireObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions, ValidationRange } from "./validationTypes";

const transformationLifecycle = {
  introduced: ITEM_MODEL_TRANSFORMATION_INTRODUCED_FORMAT
};

const transformationFields = new Set([
  "left_rotation",
  "right_rotation",
  "scale",
  "translation"
]);

export function validateItemTransformation(
  model: Record<string, JsonValue>,
  nodeSchema: ItemModelNodeSchema,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!("transformation" in model)) {
    return;
  }
  const transformationPath = appendGeneratedPath(generatedPath, "transformation");
  if (!nodeSchema.allowsTransformation) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTransformationOwner",
      "Item model type '" + nodeSchema.name + "' does not support transformation.",
      "error",
      transformationPath
    );
    return;
  }

  const target = itemModelFormatFromTarget(options.targetPackFormat);
  if (target && !isItemModelSchemaEntryAvailable(transformationLifecycle, target)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedItemTransformation",
      itemModelSchemaAvailabilityMessage("Item model transformation", transformationLifecycle, target),
      "error",
      transformationPath
    );
  }

  const transformation = model.transformation;
  if (Array.isArray(transformation)) {
    validateNumericArray(
      transformation,
      16,
      "rsgl.invalidItemTransformation",
      "Item transformation matrix must contain exactly 16 finite numbers.",
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, transformationPath)
    );
    return;
  }
  const object = requireObject(transformation, unit, diagnostics, {
    code: "rsgl.invalidItemTransformation",
    message: "Item transformation must be a matrix array or transformation object.",
    generatedPath: transformationPath
  });
  if (!object) {
    return;
  }

  for (const key of Object.keys(object)) {
    if (transformationFields.has(key)) {
      continue;
    }
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unknownItemTransformationField",
      "Unknown item transformation field '" + key + "'.",
      "error",
      appendGeneratedPath(transformationPath, key)
    );
  }

  if ("left_rotation" in object) {
    validateRotationValue(object.left_rotation, "left_rotation", unit, diagnostics, transformationPath);
  }
  if ("right_rotation" in object) {
    validateRotationValue(object.right_rotation, "right_rotation", unit, diagnostics, transformationPath);
  }
  if ("scale" in object) {
    validateNumericArray(
      object.scale,
      3,
      "rsgl.invalidItemTransformation",
      "Item transformation 'scale' must contain exactly 3 finite numbers.",
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(transformationPath, "scale"))
    );
  }
  if ("translation" in object) {
    validateNumericArray(
      object.translation,
      3,
      "rsgl.invalidItemTransformation",
      "Item transformation 'translation' must contain exactly 3 finite numbers.",
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(transformationPath, "translation"))
    );
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
      "Item transformation '" + field + "' quaternion must contain exactly 4 finite numbers.",
      unit,
      diagnostics,
      sourceRangeForGeneratedPath(unit, fieldPath)
    );
    return;
  }
  const object = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidItemTransformation",
    message: "Item transformation '" + field + "' must be a quaternion or axis-angle rotation.",
    generatedPath: fieldPath
  });
  if (!object) {
    return;
  }
  const keys = Object.keys(object);
  if (
    keys.length !== 2
    || !keys.includes("axis")
    || !keys.includes("angle")
    || typeof object.angle !== "number"
    || !Number.isFinite(object.angle)
    || !isNumericArray(object.axis, 3)
  ) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTransformation",
      "Item transformation '" + field + "' axis-angle rotation must contain exactly 'axis' and 'angle'.",
      "error",
      fieldPath
    );
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
    pushDiagnosticAtRange(diagnostics, code, message, "error", range);
  }
}

function isNumericArray(value: JsonValue | undefined, length: number): boolean {
  return Array.isArray(value)
    && value.length === length
    && value.every(item => typeof item === "number" && Number.isFinite(item));
}
