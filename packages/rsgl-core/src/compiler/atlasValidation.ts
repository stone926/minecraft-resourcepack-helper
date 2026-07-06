import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkResourceExists,
  sourceRangeForGeneratedPath,
  type RsglResourceValidationOptions
} from "./validationShared";
import { qualifyMinecraftResourceId } from "../../../mc-assets/src";

export function validateAtlasUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  const sources = Array.isArray(content?.sources) ? content.sources : [];
  for (const [index, source] of sources.entries()) {
    const sourcePath = appendGeneratedPath("/sources", String(index));
    const sourceObject = asObject(source);
    if (!sourceObject) {
      continue;
    }
    const sourceType = atlasSourceType(sourceObject.type);
    if (sourceType === "directory" && typeof sourceObject.source === "string") {
      checkResourceExists(
        "textureDirectory",
        qualifyMinecraftResourceId(sourceObject.source, namespace),
        unit,
        undefined,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath(sourcePath, "source"))
      );
    }
    if ((sourceType === "single" || sourceType === "unstitch") && typeof sourceObject.resource === "string") {
      checkResourceExists(
        "texture",
        qualifyMinecraftResourceId(sourceObject.resource, namespace),
        unit,
        undefined,
        options,
        diagnostics,
        sourceRangeForGeneratedPath(unit, appendGeneratedPath(sourcePath, "resource"))
      );
    }
    if (sourceType === "filter") {
      validateAtlasFilterPattern(sourceObject, unit, diagnostics, sourcePath);
    }
    if (sourceType === "paletted_permutations") {
      const textures = Array.isArray(sourceObject.textures) ? sourceObject.textures : [];
      for (const [textureIndex, texture] of textures.entries()) {
        if (typeof texture === "string") {
          checkResourceExists(
            "texture",
            qualifyMinecraftResourceId(texture, namespace),
            unit,
            undefined,
            options,
            diagnostics,
            sourceRangeForGeneratedPath(unit, appendGeneratedPath(appendGeneratedPath(sourcePath, "textures"), String(textureIndex)))
          );
        }
      }
      if (typeof sourceObject.palette_key === "string") {
        checkResourceExists(
          "texture",
          qualifyMinecraftResourceId(sourceObject.palette_key, namespace),
          unit,
          undefined,
          options,
          diagnostics,
          sourceRangeForGeneratedPath(unit, appendGeneratedPath(sourcePath, "palette_key"))
        );
      }
      for (const [key, texture] of Object.entries(asObject(sourceObject.permutations) ?? {})) {
        if (typeof texture === "string") {
          checkResourceExists(
            "texture",
            qualifyMinecraftResourceId(texture, namespace),
            unit,
            undefined,
            options,
            diagnostics,
            sourceRangeForGeneratedPath(unit, appendGeneratedPath(appendGeneratedPath(sourcePath, "permutations"), key))
          );
        }
      }
    }
  }
}

function atlasSourceType(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
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
      diagnostics.push({
        code: "rsgl.invalidAtlasFilterPattern",
        message: `Atlas filter ${key} pattern is not a valid regular expression.`,
        severity: "error",
        range: sourceRangeForGeneratedPath(unit, appendGeneratedPath(patternPath, key))
      });
    }
  }
}
