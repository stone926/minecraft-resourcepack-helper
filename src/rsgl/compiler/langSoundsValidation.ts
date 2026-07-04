import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

export interface LangSoundsValidationOptions {
  resourceExists?: (kind: "sound", id: string) => boolean;
  soundMetadata?: (id: string) => {
    codec?: string;
    channels?: number;
    sampleRate?: number;
    durationSeconds?: number;
  } | null | undefined;
}

export function validateLangMetadata(unit: ResourceUnit, diagnostics: RsglCompileDiagnostic[]): void {
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  if (isDeprecatedLangShape(content)) {
    validateDeprecatedLang(content, unit, diagnostics);
    return;
  }

  for (const [key, value] of Object.entries(content)) {
    if (typeof value !== "string") {
      pushUnitDiagnostic(
        diagnostics,
        unit,
        "rsgl.invalidLangValue",
        `Language key '${key}' must map to a string value.`
      );
    }
  }
}

export function validateSoundsMetadata(
  unit: ResourceUnit,
  options: LangSoundsValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  const localEvents = new Set(Object.keys(content));
  for (const [eventName, event] of Object.entries(content)) {
    validateSoundEvent(eventName, event, namespace, localEvents, unit, options, diagnostics);
  }
}

function validateDeprecatedLang(
  content: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  for (const key of Object.keys(content)) {
    if (key !== "removed" && key !== "renamed") {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidLangDeprecated", "Deprecated language metadata can only define 'removed' and 'renamed'.");
    }
  }

  if ("removed" in content) {
    const removed = content.removed;
    if (!Array.isArray(removed) || removed.some(item => typeof item !== "string")) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidLangDeprecated", "Language 'removed' must be an array of strings.");
    }
  }

  if ("renamed" in content) {
    const renamed = asObject(content.renamed);
    if (!renamed || Object.values(renamed).some(value => typeof value !== "string")) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidLangDeprecated", "Language 'renamed' must be an object mapping old keys to new key strings.");
    }
  }
}

function validateSoundEvent(
  eventName: string,
  value: JsonValue,
  namespace: string,
  localEvents: Set<string>,
  unit: ResourceUnit,
  options: LangSoundsValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const event = asObject(value);
  if (!event) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundsEvent", `Sound event '${eventName}' must be an object.`);
    return;
  }

  validateBooleanField(event, "replace", "rsgl.invalidSoundsEventField", unit, diagnostics);
  validateStringField(event, "subtitle", "rsgl.invalidSoundsEventField", unit, diagnostics);

  if (!("sounds" in event)) {
    return;
  }
  if (!Array.isArray(event.sounds)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundsList", `Sound event '${eventName}' sounds field must be an array.`);
    return;
  }

  for (const sound of event.sounds) {
    validateSoundEntry(sound, namespace, localEvents, unit, options, diagnostics);
  }
}

function validateSoundEntry(
  value: JsonValue,
  namespace: string,
  localEvents: Set<string>,
  unit: ResourceUnit,
  options: LangSoundsValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (typeof value === "string") {
    validateSoundFileReference(value, unit, options, diagnostics);
    return;
  }

  const sound = asObject(value);
  if (!sound) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundEntry", "Sound entries must be strings or objects.");
    return;
  }

  validateStringField(sound, "name", "rsgl.invalidSoundField", unit, diagnostics);
  validateEnumField(sound, "type", ["file", "event"], "rsgl.invalidSoundField", unit, diagnostics);
  validatePositiveIntegerField(sound, "weight", "rsgl.invalidSoundField", unit, diagnostics);
  validatePositiveIntegerField(sound, "attenuation_distance", "rsgl.invalidSoundField", unit, diagnostics);
  validatePositiveNumberField(sound, "volume", "rsgl.invalidSoundField", unit, diagnostics);
  validatePositiveNumberField(sound, "pitch", "rsgl.invalidSoundField", unit, diagnostics);
  validateBooleanField(sound, "preload", "rsgl.invalidSoundField", unit, diagnostics);
  validateBooleanField(sound, "stream", "rsgl.invalidSoundField", unit, diagnostics);

  if (typeof sound.name !== "string") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.missingSoundName", "Sound object entries must define a string name.");
    return;
  }

  if (sound.type === "event") {
    validateSoundEventReference(sound.name, namespace, localEvents, unit, diagnostics);
  } else {
    validateSoundFileReference(sound.name, unit, options, diagnostics);
  }
}

function validateSoundFileReference(
  value: string,
  unit: ResourceUnit,
  options: LangSoundsValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (/\s/.test(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundReference", "Sound file names must not contain whitespace.", "warning");
  }
  if (/\.ogg$/i.test(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundReference", "Sound file references should omit the .ogg extension.", "warning");
  }

  const soundId = qualifyResourceId(value, unit.id?.namespace ?? "minecraft");
  if (options.resourceExists && !options.resourceExists("sound", soundId)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.soundNotFound", `Sound not found: ${soundId}`, "warning");
    return;
  }
  validateSoundMetadata(soundId, unit, options, diagnostics);
}

function validateSoundMetadata(
  soundId: string,
  unit: ResourceUnit,
  options: LangSoundsValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!options.soundMetadata) {
    return;
  }
  const metadata = options.soundMetadata(soundId);
  if (metadata === undefined) {
    return;
  }
  if (!metadata) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundMetadata", `Sound metadata could not be read: ${soundId}`, "warning");
    return;
  }
  if (metadata.codec !== undefined && metadata.codec !== "vorbis") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundMetadata", `Sound ${soundId} uses unsupported codec '${metadata.codec}'.`, "warning");
  }
  if (!isPositiveInteger(metadata.channels)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundMetadata", `Sound ${soundId} must report a positive channel count.`, "warning");
  }
  if (!isPositiveInteger(metadata.sampleRate)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundMetadata", `Sound ${soundId} must report a positive sample rate.`, "warning");
  }
  if (metadata.durationSeconds !== undefined && (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds < 0)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundMetadata", `Sound ${soundId} must report a non-negative duration.`, "warning");
  }
}

function validateSoundEventReference(
  value: string,
  namespace: string,
  localEvents: Set<string>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const id = parseResourceId(value, namespace);
  if (id.namespace === namespace && !localEvents.has(id.path)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.soundEventNotFound", `Sound event '${value}' is not defined in this sounds resource.`, "warning");
  }
}

function isDeprecatedLangShape(content: Record<string, JsonValue>): boolean {
  const keys = Object.keys(content);
  return keys.length > 0 && keys.every(key => key === "removed" || key === "renamed");
}

function validateStringField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && typeof object[field] !== "string") {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a string.`);
  }
}

function validateEnumField(
  object: Record<string, JsonValue>,
  field: string,
  values: string[],
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (typeof object[field] !== "string" || !values.includes(object[field] as string))) {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' has an invalid value.`);
  }
}

function validateBooleanField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && typeof object[field] !== "boolean") {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a boolean.`);
  }
}

function validatePositiveIntegerField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (!Number.isInteger(object[field]) || Number(object[field]) <= 0)) {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a positive integer.`);
  }
}

function validatePositiveNumberField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (field in object && (typeof object[field] !== "number" || !Number.isFinite(object[field]) || Number(object[field]) <= 0)) {
    pushUnitDiagnostic(diagnostics, unit, code, `Field '${field}' must be a positive number.`);
  }
}

function qualifyResourceId(value: string, defaultNamespace: string): string {
  return value.includes(":") ? value : `${defaultNamespace}:${value}`;
}

function parseResourceId(value: string, defaultNamespace: string): { namespace: string; path: string } {
  const separator = value.indexOf(":");
  return separator >= 0
    ? { namespace: value.slice(0, separator), path: value.slice(separator + 1) }
    : { namespace: defaultNamespace, path: value };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
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
