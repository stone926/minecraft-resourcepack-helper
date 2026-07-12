import { qualifyMinecraftResourceId } from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { checkResourceExists } from "./resourceReferenceValidation";
import { pushUnitDiagnostic, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import {
  asObject,
  requireArray,
  requireFiniteNumber,
  requireObject,
  stripMinecraftPrefix,
  validateStringField
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
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
  const providers = requireArray(content.providers, unit, diagnostics, {
    code: "rsgl.invalidFontProviders",
    message: "Font resource must define a providers array."
  });
  if (!providers) {
    return;
  }

  const namespace = unit.id?.namespace ?? "minecraft";
  for (const [providerIndex, provider] of providers.entries()) {
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
  const provider = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidFontProvider",
    message: "Font providers must be objects."
  });
  if (!provider) {
    return;
  }

  const type = stripMinecraftPrefix(provider.type);
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
  if (value === undefined) {
    return;
  }
  const filter = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidFontProviderField",
    message: "Font provider 'filter' must be an object."
  });
  if (!filter) {
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
  if (value === undefined) {
    return;
  }
  const advances = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidFontProviderField",
    message: "Font provider 'advances' must be an object."
  });
  if (!advances) {
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
  const overrides = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidFontProviderField",
    message: "Font provider 'size_overrides' must be an array."
  });
  if (!overrides) {
    return;
  }
  for (const item of overrides) {
    const override = requireObject(item, unit, diagnostics, {
      code: "rsgl.invalidFontProviderField",
      message: "Font provider size overrides must be objects."
    });
    if (!override) {
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
  if (field in object) {
    requireFiniteNumber(object[field], unit, diagnostics, {
      code,
      message: `Field '${field}' must be a finite number.`
    });
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
