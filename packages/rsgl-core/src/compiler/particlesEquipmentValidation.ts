import { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { checkResourceExists } from "./resourceReferenceValidation";
import { sourceRangeForGeneratedPath } from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
import { minecraftResourceIdInFolder } from "../../../mc-assets/src";

export function validateParticlesUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  const textures = Array.isArray(content?.textures) ? content.textures : [];
  for (const [index, texture] of textures.entries()) {
    if (typeof texture === "string") {
      checkResourceExists(
        "texture",
        minecraftResourceIdInFolder(texture, namespace, "particle"),
        unit,
        undefined,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath("/textures", String(index)))
      );
    }
  }
}

export function validateEquipmentUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
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
      const texture = asObject(layerEntry)?.texture;
      if (typeof texture === "string") {
        const texturePath = appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath("/layers", layerName), String(index)),
          "texture"
        );
        checkResourceExists(
          "texture",
          minecraftResourceIdInFolder(texture, namespace, `entity/equipment/${layerName}`),
          unit,
          undefined,
          options,
          diagnostics,
          sourceRangeForGeneratedPath(unit, texturePath)
        );
      }
    }
  }
}
