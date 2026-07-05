import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

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
    checkTextureExists(textureIdInFolder(sprite, namespace, spriteTextureFolder), unit, options, diagnostics);
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

function textureIdInFolder(value: string, defaultNamespace: string, folder: string): string {
  const id = parseResourceId(value, defaultNamespace);
  const path = id.path.startsWith(`${folder}/`) ? id.path : `${folder}/${id.path}`;
  return `${id.namespace}:${path}`;
}

function parseResourceId(value: string, defaultNamespace: string): { namespace: string; path: string } {
  const separator = value.indexOf(":");
  return separator >= 0
    ? { namespace: value.slice(0, separator), path: value.slice(separator + 1) }
    : { namespace: defaultNamespace, path: value };
}

function pushUnitDiagnostic(
  diagnostics: RsglCompileDiagnostic[],
  unit: ResourceUnit,
  code: string,
  message: string,
  severity: RsglCompileDiagnostic["severity"] = "error"
): void {
  diagnostics.push({
    code,
    message,
    severity,
    range: unit.sourceMap.mappings[0].sourceRange
  });
}

function asObject(value: unknown): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}
