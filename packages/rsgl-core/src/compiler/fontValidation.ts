import { qualifyMinecraftResourceId } from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  asObject,
  checkResourceExists,
  pushUnitDiagnostic,
  sourceRangeForGeneratedPath,
  type RsglResourceValidationOptions,
  validateStringField
} from "./validationShared";
import { appendGeneratedPath } from "./sourcePaths";

export type FontValidationOptions = RsglResourceValidationOptions;

const providerRequiredFields = new Map<string, string[]>([
  ["bitmap", ["file", "chars", "ascent"]],
  ["space", ["advances"]],
  ["ttf", ["file"]],
  ["unihex", ["hex_file"]],
  ["reference", ["id"]],
  ["legacy_unicode", ["template", "sizes"]]
]);

export function validateFontMetadata(
  unit: ResourceUnit,
  generatedFonts: Set<string>,
  options: FontValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  if (!content) {
    return;
  }
  if (!Array.isArray(content.providers)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviders", "Font resource must define a providers array.");
    return;
  }

  const namespace = unit.id?.namespace ?? "minecraft";
  for (const [providerIndex, provider] of content.providers.entries()) {
    validateFontProvider(
      provider,
      namespace,
      generatedFonts,
      unit,
      options,
      diagnostics,
      appendGeneratedPath("/providers", String(providerIndex))
    );
  }
}

function validateFontProvider(
  value: JsonValue,
  namespace: string,
  generatedFonts: Set<string>,
  unit: ResourceUnit,
  options: FontValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const provider = asObject(value);
  if (!provider) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProvider", "Font providers must be objects.");
    return;
  }

  const type = providerType(provider.type);
  const requiredFields = type ? providerRequiredFields.get(type) : undefined;
  if (!type || !requiredFields) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderType", "Font provider must define a known provider type.");
    return;
  }

  for (const field of requiredFields) {
    if (!(field in provider)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.missingFontProviderField", `Font provider '${type}' must define '${field}'.`);
    }
  }

  validateFontProviderFields(provider, type, namespace, generatedFonts, unit, options, diagnostics, generatedPath);
}

function validateFontProviderFields(
  provider: Record<string, JsonValue>,
  type: string,
  namespace: string,
  generatedFonts: Set<string>,
  unit: ResourceUnit,
  options: FontValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  validateNumberField(provider, "ascent", "rsgl.invalidFontProviderField", unit, diagnostics);
  validateNumberField(provider, "height", "rsgl.invalidFontProviderField", unit, diagnostics);
  validateNumberField(provider, "size", "rsgl.invalidFontProviderField", unit, diagnostics);
  validateNumberField(provider, "oversample", "rsgl.invalidFontProviderField", unit, diagnostics);
  validateShift(provider.shift, unit, diagnostics);
  validateFilter(provider.filter, unit, diagnostics);

  if (type === "bitmap") {
    validateStringField(provider, "file", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateStringArrayField(provider, "chars", "rsgl.invalidFontProviderField", unit, diagnostics);
    if (typeof provider.file === "string") {
      checkFontResourceExists(
        "texture",
        qualifyMinecraftResourceId(provider.file, namespace),
        unit,
        generatedFonts,
        options,
        diagnostics,
        appendGeneratedPath(generatedPath, "file")
      );
    }
  } else if (type === "reference") {
    validateStringField(provider, "id", "rsgl.invalidFontProviderField", unit, diagnostics);
    if (typeof provider.id === "string") {
      checkFontResourceExists(
        "font",
        qualifyMinecraftResourceId(provider.id, namespace),
        unit,
        generatedFonts,
        options,
        diagnostics,
        appendGeneratedPath(generatedPath, "id")
      );
    }
  } else if (type === "ttf") {
    validateStringField(provider, "file", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateSkip(provider.skip, unit, diagnostics);
    if (typeof provider.file === "string") {
      checkFontResourceExists(
        "fontFile",
        qualifyMinecraftResourceId(provider.file, namespace),
        unit,
        generatedFonts,
        options,
        diagnostics,
        appendGeneratedPath(generatedPath, "file")
      );
    }
  } else if (type === "unihex") {
    validateStringField(provider, "hex_file", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateSizeOverrides(provider["size_overrides"], unit, diagnostics);
    if (typeof provider["hex_file"] === "string") {
      checkFontResourceExists(
        "fontFile",
        qualifyMinecraftResourceId(provider["hex_file"], namespace),
        unit,
        generatedFonts,
        options,
        diagnostics,
        appendGeneratedPath(generatedPath, "hex_file")
      );
    }
  } else if (type === "space") {
    validateAdvances(provider.advances, unit, diagnostics);
  } else if (type === "legacy_unicode") {
    validateStringField(provider, "template", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateStringField(provider, "sizes", "rsgl.invalidFontProviderField", unit, diagnostics);
  }
}

function validateShift(value: JsonValue | undefined, unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => !Number.isInteger(item) || Number(item) < -512 || Number(item) > 512)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider 'shift' must contain two integers between -512 and 512.");
  }
}

function validateFilter(value: JsonValue | undefined, unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  const filter = asObject(value);
  if (!filter) {
    if (value !== undefined) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider 'filter' must be an object.");
    }
    return;
  }
  for (const field of ["uniform", "jp"]) {
    if (field in filter && typeof filter[field] !== "boolean") {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", `Font provider filter '${field}' must be a boolean.`);
    }
  }
}

function validateSkip(value: JsonValue | undefined, unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  if (value === undefined || typeof value === "string") {
    return;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider 'skip' must be a string or array of strings.");
  }
}

function validateAdvances(value: JsonValue | undefined, unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  const advances = asObject(value);
  if (!advances) {
    if (value !== undefined) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider 'advances' must be an object.");
    }
    return;
  }
  for (const advance of Object.values(advances)) {
    if (typeof advance !== "number" || !Number.isFinite(advance)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider advances values must be finite numbers.");
    }
  }
}

function validateSizeOverrides(value: JsonValue | undefined, unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider 'size_overrides' must be an array.");
    return;
  }
  for (const item of value) {
    const override = asObject(item);
    if (!override) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", "Font provider size overrides must be objects.");
      continue;
    }
    validateStringField(override, "from", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateStringField(override, "to", "rsgl.invalidFontProviderField", unit, diagnostics);
    validateIntegerInRange(override, "left", 0, 32, unit, diagnostics);
    validateIntegerInRange(override, "right", 0, 32, unit, diagnostics);
    validateStringArrayField(override, "ranges", "rsgl.invalidFontProviderField", unit, diagnostics);
  }
}

function validateStringArrayField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (!Array.isArray(object[field]) || (object[field] as JsonValue[]).some(item => typeof item !== "string"))) {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be an array of strings.`);
  }
}

function validateNumberField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (typeof object[field] !== "number" || !Number.isFinite(object[field]))) {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a finite number.`);
  }
}

function validateIntegerInRange(
  object: Record<string, JsonValue>,
  field: string,
  min: number,
  max: number,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidFontProviderField", `Field '${field}' must be an integer between ${min} and ${max}.`);
  }
}

function checkFontResourceExists(
  kind: "font" | "fontFile" | "texture",
  id: string,
  unit: ResourceUnit,
  generatedFonts: Set<string>,
  options: FontValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (kind === "font" && generatedFonts.has(id)) {
    return;
  }
  checkResourceExists(
    kind,
    id,
    unit,
    undefined,
    options,
    diagnostics,
    sourceRangeForGeneratedPath(unit, generatedPath)
  );
}

function providerType(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
