import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  sourceRangeForGeneratedPath,
  unitRange,
  type ValidationRange
} from "./validationShared";

export function validateItemTransformation(
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
