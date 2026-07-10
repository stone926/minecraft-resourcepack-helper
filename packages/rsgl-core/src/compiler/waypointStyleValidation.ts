import { minecraftResourceIdInFolder } from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { asObject, pushUnitDiagnostic } from "./validationShared";

export interface WaypointStyleValidationOptions {
  resourceExists?: (kind: "texture", id: string) => boolean;
}

const minDistance = 0;
const maxDistance = 60000000;
const spriteTextureFolder = "gui/sprites/hud/locator_bar_dot";

export function validateWaypointStyleMetadata(
  unit: ResourceUnit,
  options: WaypointStyleValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  if (!content) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointStyle", "Waypoint style resource must be an object.");
    return;
  }

  validateDistanceField(content, "near_distance", unit, diagnostics);
  validateDistanceField(content, "far_distance", unit, diagnostics);
  validateDistanceOrder(content, unit, diagnostics);
  validateSprites(content.sprites, unit.id?.namespace ?? "minecraft", unit, options, diagnostics);
}

function validateSprites(
  value: JsonValue | undefined,
  namespace: string,
  unit: ResourceUnit,
  options: WaypointStyleValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.missingWaypointSprites", "Waypoint style resource must define a sprites array.");
    return;
  }
  if (!Array.isArray(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointSprites", "Waypoint style 'sprites' must be an array.");
    return;
  }
  if (value.length === 0) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointSprites", "Waypoint style 'sprites' must contain at least one sprite.");
  }

  for (const sprite of value) {
    if (typeof sprite !== "string" || sprite.length === 0) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidWaypointSprite", "Waypoint style sprites must be non-empty strings.");
      continue;
    }
    checkTextureExists(minecraftResourceIdInFolder(sprite, namespace, spriteTextureFolder), unit, options, diagnostics);
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < minDistance || value > maxDistance) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidWaypointDistance",
      `Waypoint style '${field}' must be a finite number between ${minDistance} and ${maxDistance}.`
    );
  }
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

function checkTextureExists(
  id: string,
  unit: ResourceUnit,
  options: WaypointStyleValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!options.resourceExists || options.resourceExists("texture", id)) {
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, "rsgl.textureNotFound", `Texture not found: ${id}`, "warning");
}
