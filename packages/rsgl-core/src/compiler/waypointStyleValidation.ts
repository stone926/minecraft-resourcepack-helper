import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { pushUnitDiagnostic, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import { requireArray, requireNumberInRange, requireObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
import { appendGeneratedPath } from "./sourcePaths";

export type WaypointStyleValidationOptions = RsglResourceValidationOptions;

const minDistance = 0;
const maxDistance = 60000000;

export function validateWaypointStyleMetadata(
  unit: ResourceUnit,
  options: WaypointStyleValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = requireObject(unit.content, unit, diagnostics, {
    code: "rsgl.invalidWaypointStyle",
    message: "Waypoint style resource must be an object."
  });
  if (!content) {
    return;
  }

  validateDistanceField(content, "near_distance", unit, diagnostics);
  validateDistanceField(content, "far_distance", unit, diagnostics);
  validateDistanceOrder(content, unit, diagnostics);
  validateSprites(content.sprites, unit, options, diagnostics);
}

function validateSprites(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  options: WaypointStyleValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.missingWaypointSprites", "Waypoint style resource must define a sprites array.");
    return;
  }
  const sprites = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidWaypointSprites",
    message: "Waypoint style 'sprites' must be an array."
  });
  if (!sprites) {
    return;
  }
  if (sprites.length === 0) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointSprites", "Waypoint style 'sprites' must contain at least one sprite.");
  }

  for (const [spriteIndex, sprite] of sprites.entries()) {
    if (typeof sprite !== "string") {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointSprite", "Waypoint style sprites must be non-empty strings.");
      continue;
    }
    checkJsonResourceReference(
      sprites,
      spriteIndex,
      "waypointSpriteTexture",
      unit,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath("/sprites", String(spriteIndex)))
    );
  }
}

function validateDistanceField(
  content: Record<string, JsonValue>,
  field: "near_distance" | "far_distance",
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = content[field];
  if (value === undefined) {
    return;
  }
  requireNumberInRange(value, minDistance, maxDistance, unit, diagnostics, {
    code: "rsgl.invalidWaypointDistance",
    message: `Waypoint style '${field}' must be a finite number between ${minDistance} and ${maxDistance}.`
  });
}

function validateDistanceOrder(
  content: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const near = content.near_distance;
  const far = content.far_distance;
  if (typeof near !== "number" || typeof far !== "number" || !Number.isFinite(near) || !Number.isFinite(far)) {
    return;
  }
  if (far <= near) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointDistanceRange", "Waypoint style 'far_distance' should be greater than 'near_distance'.");
  }
}
