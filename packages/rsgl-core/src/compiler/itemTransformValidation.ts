import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { pushDiagnosticAtRange, pushUnitDiagnostic, sourceRangeForGeneratedPath, unitRange } from "./validationDiagnostics";
import { requireObject } from "./validationPrimitives";
import type { ValidationRange } from "./validationTypes";

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
  const object = requireObject(transformation, unit, diagnostics, {
    code: "rsgl.invalidItemTransformation",
    message: "Item transformation must be a matrix array or transformation object.",
    generatedPath: transformationPath
  });
  if (!object) {
    return;
  }

  for (const field of ["left_rotation", "right_rotation", "scale", "translation"]) {
    if (!(field in object)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.missingItemTransformationField", `Item transformation must define '${field}'.`, "error", transformationPath);
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
  const object = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidItemTransformation",
    message: `Item transformation '${field}' must be a quaternion or axis-angle rotation.`,
    generatedPath: fieldPath
  });
  if (object && (typeof object.angle !== "number" || !Number.isFinite(object.angle) || !isNumericArray(object.axis, 3))) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidItemTransformation",
      `Item transformation '${field}' must be a quaternion or axis-angle rotation.`,
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
