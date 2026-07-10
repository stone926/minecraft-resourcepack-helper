import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { asObject, pushUnitDiagnostic } from "./validationShared";

export interface PackMetadataValidationOptions {
  targetPackFormat?: { major: number; minor?: number };
}

interface PackFormatVersion {
  major: number;
  minor: number;
}

interface LegacyFormatRange {
  min: number;
  max: number;
}

const modernPackFormatBoundary = 65;

export function validatePackMetadata(
  unit: ResourceUnit,
  options: PackMetadataValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  if (Object.hasOwn(content, "pack")) {
    const pack = asObject(content.pack);
    if (pack) {
      validatePackFormatMetadata(pack, unit, options, diagnostics);
    } else {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackMetadata", "pack.mcmeta 'pack' must be an object.");
    }
  }

  validatePackFilter(content, unit, diagnostics);
  validatePackOverlays(content, unit, options, diagnostics);
}

function validatePackFormatMetadata(
  pack: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: PackMetadataValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const hasPackFormat = Object.hasOwn(pack, "pack_format");
  const hasSupportedFormats = Object.hasOwn(pack, "supported_formats");
  const hasMinFormat = Object.hasOwn(pack, "min_format");
  const hasMaxFormat = Object.hasOwn(pack, "max_format");

  const packFormat = hasPackFormat ? legacyPackFormatValue(pack.pack_format) : null;
  const supportedFormats = hasSupportedFormats ? legacyFormatRangeValue(pack.supported_formats) : null;
  const minFormat = hasMinFormat ? packFormatValue(pack.min_format, false) : null;
  const maxFormat = hasMaxFormat ? packFormatValue(pack.max_format, true) : null;

  if (hasPackFormat && packFormat === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackFormatField", "pack_format must be a positive integer.");
  }
  if (hasSupportedFormats && supportedFormats === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackSupportedFormats", "supported_formats must be a positive integer, range tuple, or range object.");
  }
  if (hasMinFormat && minFormat === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackFormatField", "min_format must be a non-negative integer or [major, minor] tuple.");
  }
  if (hasMaxFormat && maxFormat === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackFormatField", "max_format must be a non-negative integer or [major, minor] tuple.");
  }

  if (hasMinFormat !== hasMaxFormat) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.incompletePackFormatRange", "pack.mcmeta must use min_format and max_format together.");
  }

  const hasValidModernRange = minFormat !== null && maxFormat !== null && comparePackFormats(minFormat, maxFormat) <= 0;
  if (minFormat && maxFormat && !hasValidModernRange) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackFormatRange", "pack.mcmeta min_format must not be greater than max_format.");
  }

  if (supportedFormats && supportedFormats.min > supportedFormats.max) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPackSupportedFormats", "supported_formats minimum must not be greater than maximum.");
  }

  if (hasValidModernRange) {
    validatePackFormatBoundaryFields(pack, minFormat, maxFormat, supportedFormats, unit, diagnostics);
  } else if (packFormat !== null && packFormat >= modernPackFormatBoundary && !hasMinFormat && !hasMaxFormat) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidPackFormatField",
      "pack_format is only for resource pack formats before 65; use min_format and max_format.",
      "warning"
    );
  }

  validatePackTargetFormat(packFormat, supportedFormats, minFormat, maxFormat, unit, options, diagnostics);
}

function validatePackFormatBoundaryFields(
  pack: Record<string, JsonValue>,
  minFormat: PackFormatVersion,
  maxFormat: PackFormatVersion,
  supportedFormats: LegacyFormatRange | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const hasPackFormat = Object.hasOwn(pack, "pack_format");
  const hasSupportedFormats = Object.hasOwn(pack, "supported_formats");
  const modernOnly = minFormat.major >= modernPackFormatBoundary;
  const legacyOnly = maxFormat.major < modernPackFormatBoundary;
  const crossesBoundary = minFormat.major < modernPackFormatBoundary && maxFormat.major >= modernPackFormatBoundary;

  if (modernOnly && (hasPackFormat || hasSupportedFormats)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedPackFormatFields",
      "Resource packs that only support pack format 65 or newer must not use pack_format or supported_formats.",
      "warning"
    );
  }

  if (legacyOnly && !hasPackFormat) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.missingLegacyPackFormat",
      "Resource packs that only support pack formats before 65 must include pack_format.",
      "warning"
    );
  }

  if (crossesBoundary) {
    for (const field of ["pack_format", "supported_formats", "min_format", "max_format"]) {
      if (!Object.hasOwn(pack, field)) {
        pushUnitDiagnostic(
          diagnostics,
          unit,
          "rsgl.missingPackFormatField",
          `Resource packs crossing the pack format 65 boundary must include '${field}'.`,
          "warning"
        );
      }
    }
    if (supportedFormats && supportedFormats.max !== modernPackFormatBoundary - 1) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidPackSupportedFormats",
        "Resource packs crossing the pack format 65 boundary must set supported_formats maximum to 64.",
        "warning"
      );
    }
  }
}

function validatePackTargetFormat(
  packFormat: number | null,
  supportedFormats: LegacyFormatRange | null,
  minFormat: PackFormatVersion | null,
  maxFormat: PackFormatVersion | null,
  unit: ResourceUnit,
  options: PackMetadataValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const target = targetPackFormatValue(options);
  if (!target) {
    return;
  }

  const range = declaredPackFormatRange(packFormat, supportedFormats, minFormat, maxFormat);
  if (!range) {
    return;
  }

  if (comparePackFormats(target, range.min) < 0 || comparePackFormats(target, range.max) > 0) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.packOutsideTargetFormat",
      "pack.mcmeta format range does not include the compile target pack format.",
      "warning"
    );
  }
}

function declaredPackFormatRange(
  packFormat: number | null,
  supportedFormats: LegacyFormatRange | null,
  minFormat: PackFormatVersion | null,
  maxFormat: PackFormatVersion | null
): { min: PackFormatVersion; max: PackFormatVersion } | null {
  if (minFormat && maxFormat && comparePackFormats(minFormat, maxFormat) <= 0) {
    return { min: minFormat, max: maxFormat };
  }
  if (packFormat !== null) {
    return {
      min: { major: packFormat, minor: 0 },
      max: { major: packFormat, minor: Number.MAX_SAFE_INTEGER }
    };
  }
  if (supportedFormats && supportedFormats.min <= supportedFormats.max) {
    return {
      min: { major: supportedFormats.min, minor: 0 },
      max: { major: supportedFormats.max, minor: Number.MAX_SAFE_INTEGER }
    };
  }
  return null;
}

function validatePackFilter(
  content: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const filter = asObject(content.filter);
  const blocks = Array.isArray(filter?.block) ? filter.block : [];
  for (const block of blocks) {
    const blockObject = asObject(block);
    if (!blockObject) {
      continue;
    }
    validateRegexField(blockObject, "namespace", "rsgl.invalidPackFilterPattern", unit, diagnostics);
    validateRegexField(blockObject, "path", "rsgl.invalidPackFilterPattern", unit, diagnostics);
  }
}

function validatePackOverlays(
  content: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: PackMetadataValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const overlays = asObject(content.overlays);
  if (!overlays) {
    if (Object.hasOwn(content, "overlays")) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayEntry", "pack.mcmeta overlays must be an object.");
    }
    return;
  }

  if (!Object.hasOwn(overlays, "entries")) {
    return;
  }
  if (!Array.isArray(overlays.entries)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayEntry", "pack.mcmeta overlays.entries must be an array.");
    return;
  }

  const entries = overlays.entries as JsonValue[];
  const directories = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const entryPath = overlayEntryPath(index);
    const overlay = asObject(entry);
    if (!overlay) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayEntry", "Overlay entries must be objects.", "error", entryPath);
      continue;
    }
    if (typeof overlay.directory !== "string" || !/^[a-z0-9_-]+$/.test(overlay.directory)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidOverlayDirectory",
        "Overlay directory must contain only lowercase letters, numbers, '_' or '-'.",
        "error",
        entryPath
      );
    } else if (directories.has(overlay.directory)) {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.duplicateOverlayDirectory",
        `Overlay directory '${overlay.directory}' is declared more than once.`,
        "error",
        entryPath
      );
    } else {
      directories.add(overlay.directory);
    }
    validateOverlayRange(overlay, unit, options, diagnostics, entryPath);
  }
}

function validateOverlayRange(
  overlay: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: PackMetadataValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const hasMin = Object.hasOwn(overlay, "min_format");
  const hasMax = Object.hasOwn(overlay, "max_format");
  const hasFormats = Object.hasOwn(overlay, "formats");
  const min = hasMin ? packFormatValue(overlay.min_format, false) : null;
  const max = hasMax ? packFormatValue(overlay.max_format, true) : null;
  const legacyFormats = hasFormats ? legacyFormatRangeValue(overlay.formats) : null;

  if (hasMin && min === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay min_format must be a non-negative integer or [major, minor] tuple.", "error", generatedPath);
  }
  if (hasMax && max === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay max_format must be a non-negative integer or [major, minor] tuple.", "error", generatedPath);
  }
  if (hasMin !== hasMax) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay min_format and max_format must be used together.", "error", generatedPath);
  }
  if (hasFormats && legacyFormats === null) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay formats must be a positive integer, range tuple, or range object.", "error", generatedPath);
  }

  const hasValidRange = min !== null && max !== null && comparePackFormats(min, max) <= 0;
  if (min && max && !hasValidRange) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay min_format must not be greater than max_format.", "error", generatedPath);
  }
  if (legacyFormats && legacyFormats.min > legacyFormats.max) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidOverlayFormatRange", "Overlay formats minimum must not be greater than maximum.", "error", generatedPath);
  }

  const target = targetPackFormatValue(options);
  if (!target) {
    return;
  }

  if (hasValidRange && (comparePackFormats(target, min) < 0 || comparePackFormats(target, max) > 0)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.overlayOutsideTargetFormat", "Overlay format range does not include the compile target pack format.", "warning", generatedPath);
  } else if (!hasValidRange && legacyFormats && legacyFormats.min <= legacyFormats.max) {
    if (target.major >= modernPackFormatBoundary || target.major < legacyFormats.min || target.major > legacyFormats.max) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.overlayOutsideTargetFormat", "Overlay legacy formats do not include the compile target pack format.", "warning", generatedPath);
    }
  }
}

function validateRegexField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = object[field];
  if (typeof value !== "string") {
    return;
  }
  try {
    new RegExp(value);
  } catch {
    pushUnitDiagnostic(diagnostics, unit, code, `Pack filter ${field} pattern is not a valid regular expression.`);
  }
}

function packFormatValue(value: JsonValue | undefined, isMaxFormat: boolean): PackFormatVersion | null {
  if (isNonNegativeInteger(value)) {
    return {
      major: value,
      minor: isMaxFormat ? Number.MAX_SAFE_INTEGER : 0
    };
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || !value.every(isNonNegativeInteger)) {
    return null;
  }
  return {
    major: value[0],
    minor: value.length === 2 ? value[1] : (isMaxFormat ? Number.MAX_SAFE_INTEGER : 0)
  };
}

function legacyPackFormatValue(value: JsonValue | undefined): number | null {
  return isPositiveInteger(value) ? value : null;
}

function legacyFormatRangeValue(value: JsonValue | undefined): LegacyFormatRange | null {
  if (isPositiveInteger(value)) {
    return { min: value, max: value };
  }
  if (Array.isArray(value) && value.length === 2 && value.every(isPositiveInteger)) {
    return { min: value[0], max: value[1] };
  }
  const object = asObject(value);
  if (object && isPositiveInteger(object.min_inclusive) && isPositiveInteger(object.max_inclusive)) {
    return { min: object.min_inclusive, max: object.max_inclusive };
  }
  return null;
}

function targetPackFormatValue(options: PackMetadataValidationOptions): PackFormatVersion | null {
  return options.targetPackFormat
    ? { major: options.targetPackFormat.major, minor: options.targetPackFormat.minor ?? 0 }
    : null;
}

function comparePackFormats(left: PackFormatVersion, right: PackFormatVersion): number {
  return left.major === right.major ? left.minor - right.minor : left.major - right.major;
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function overlayEntryPath(index: number): string {
  return `/overlays/entries/${index}`;
}
