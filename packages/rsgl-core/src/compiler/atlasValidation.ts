import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import {
  canonicalizeJsonResourceReference,
  checkJsonResourceReference
} from "./jsonResourceReferenceValidation";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import { asObject, stripMinecraftPrefix } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

export function validateAtlasUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  const sources = Array.isArray(content?.sources) ? content.sources : [];
  for (const [index, source] of sources.entries()) {
    const sourcePath = appendGeneratedPath("/sources", String(index));
    const sourceObject = asObject(source);
    if (!sourceObject) {
      continue;
    }
    const sourceType = stripMinecraftPrefix(sourceObject.type);
    if (sourceType === "directory" && typeof sourceObject.source === "string") {
      checkJsonResourceReference(
        sourceObject,
        "source",
        "textureDirectory",
        unit,
        options,
        diagnostics,
        appendGeneratedPath(sourcePath, "source")
      );
    }
    if ((sourceType === "single" || sourceType === "unstitch") && typeof sourceObject.resource === "string") {
      checkJsonResourceReference(
        sourceObject,
        "resource",
        "texture",
        unit,
        options,
        diagnostics,
        appendGeneratedPath(sourcePath, "resource")
      );
    }
    if (sourceType === "single" && typeof sourceObject.sprite === "string") {
      canonicalizeJsonResourceReference(
        sourceObject,
        "sprite",
        "texture",
        unit,
        diagnostics,
        appendGeneratedPath(sourcePath, "sprite")
      );
    }
    if (sourceType === "unstitch" && Array.isArray(sourceObject.regions)) {
      for (const [regionIndex, regionValue] of sourceObject.regions.entries()) {
        const region = asObject(regionValue);
        if (typeof region?.sprite !== "string") {
          continue;
        }
        const spritePath = appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath(sourcePath, "regions"), String(regionIndex)),
          "sprite"
        );
        canonicalizeJsonResourceReference(
          region,
          "sprite",
          "texture",
          unit,
          diagnostics,
          spritePath
        );
      }
    }
    if (sourceType === "filter") {
      validateAtlasFilterPattern(sourceObject, unit, diagnostics, sourcePath);
    }
    if (sourceType === "paletted_permutations") {
      const textures = Array.isArray(sourceObject.textures) ? sourceObject.textures : [];
      for (const [textureIndex, texture] of textures.entries()) {
        if (typeof texture === "string") {
          checkJsonResourceReference(
            textures,
            textureIndex,
            "texture",
            unit,
            options,
            diagnostics,
            appendGeneratedPath(appendGeneratedPath(sourcePath, "textures"), String(textureIndex))
          );
        }
      }
      if (typeof sourceObject.palette_key === "string") {
        checkJsonResourceReference(
          sourceObject,
          "palette_key",
          "texture",
          unit,
          options,
          diagnostics,
          appendGeneratedPath(sourcePath, "palette_key")
        );
      }
      const permutations = asObject(sourceObject.permutations) ?? {};
      for (const [key, texture] of Object.entries(permutations)) {
        if (typeof texture === "string") {
          checkJsonResourceReference(
            permutations,
            key,
            "texture",
            unit,
            options,
            diagnostics,
            appendGeneratedPath(appendGeneratedPath(sourcePath, "permutations"), key)
          );
        }
      }
    }
  }
}

function validateAtlasFilterPattern(
  sourceObject: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const pattern = asObject(sourceObject.pattern);
  if (!pattern) {
    return;
  }
  const patternPath = appendGeneratedPath(generatedPath, "pattern");
  for (const key of ["namespace", "path"]) {
    const value = pattern[key];
    if (typeof value !== "string") {
      continue;
    }
    try {
      new RegExp(value);
    } catch {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidAtlasFilterPattern",
        `Atlas filter ${key} pattern is not a valid regular expression.`,
        "error",
        appendGeneratedPath(patternPath, key)
      );
    }
  }
}
