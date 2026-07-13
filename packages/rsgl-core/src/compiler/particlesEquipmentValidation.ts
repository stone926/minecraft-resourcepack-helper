import { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { asObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export function validateParticlesUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const textures = Array.isArray(content?.textures) ? content.textures : [];
  for (const [index, texture] of textures.entries()) {
    if (typeof texture === "string") {
      checkJsonResourceReference(
        textures,
        index,
        "particleTexture",
        unit,
        options,
        diagnostics,
        appendGeneratedPath("/textures", String(index))
      );
    }
  }
}

export function validateEquipmentUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const layers = asObject(content?.layers);
  if (!layers) {
    return;
  }

  for (const [layerName, layerEntries] of Object.entries(layers)) {
    if (!Array.isArray(layerEntries)) {
      continue;
    }
    for (const [index, layerEntry] of layerEntries.entries()) {
      const layerObject = asObject(layerEntry);
      const texture = layerObject?.texture;
      if (typeof texture === "string") {
        const texturePath = appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath("/layers", layerName), String(index)),
          "texture"
        );
        checkJsonResourceReference(
          layerObject!,
          "texture",
          "equipmentTexture",
          unit,
          options,
          diagnostics,
          texturePath,
          undefined,
          unit.id?.namespace ?? "minecraft",
          { equipmentLayer: layerName }
        );
      }
    }
  }
}
