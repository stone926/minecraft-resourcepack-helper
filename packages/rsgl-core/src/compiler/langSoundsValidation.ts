import { tryParseMinecraftResourceId } from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  canonicalizeJsonResourceReference,
  checkJsonResourceReference
} from "./jsonResourceReferenceValidation";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import {
  asObject,
  isPositiveInteger,
  requireArray,
  requireEnum,
  requireObject,
  requirePositiveInteger,
  requirePositiveNumber,
  validateBooleanField,
  validateStringField
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
import type { ExternResourceSource } from "../externDeclarations";
import { appendGeneratedPath } from "./sourcePaths";

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
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const namespace = unit.id?.namespace ?? "minecraft";
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  const localEvents = new Set(Object.keys(content));
  for (const [eventName, event] of Object.entries(content)) {
    validateSoundEvent(
      eventName,
      event,
      namespace,
      localEvents,
      unit,
      options,
      diagnostics,
      appendGeneratedPath("", eventName)
    );
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
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const event = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidSoundsEvent",
    message: `Sound event '${eventName}' must be an object.`
  });
  if (!event) {
    return;
  }

  validateBooleanField(event, "replace", "rsgl.invalidSoundsEventField", unit, diagnostics);
  validateStringField(event, "subtitle", "rsgl.invalidSoundsEventField", unit, diagnostics);

  if (!("sounds" in event)) {
    return;
  }
  const sounds = requireArray(event.sounds, unit, diagnostics, {
    code: "rsgl.invalidSoundsList",
    message: `Sound event '${eventName}' sounds field must be an array.`
  });
  if (!sounds) {
    return;
  }

  const soundsPath = appendGeneratedPath(generatedPath, "sounds");
  for (const [soundIndex] of sounds.entries()) {
    validateSoundEntry(
      sounds,
      soundIndex,
      namespace,
      localEvents,
      unit,
      options,
      diagnostics,
      appendGeneratedPath(soundsPath, String(soundIndex))
    );
  }
}

function validateSoundEntry(
  sounds: JsonValue[],
  soundIndex: number,
  namespace: string,
  localEvents: Set<string>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const value = sounds[soundIndex];
  if (typeof value === "string") {
    validateSoundFileReference(sounds, soundIndex, value, unit, options, diagnostics, generatedPath);
    return;
  }

  const sound = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidSoundEntry",
    message: "Sound entries must be strings or objects."
  });
  if (!sound) {
    return;
  }

  validateStringField(sound, "name", "rsgl.invalidSoundField", unit, diagnostics);
  if ("type" in sound) {
    requireEnum(sound.type, ["file", "event"], unit, diagnostics, {
      code: "rsgl.invalidSoundField",
      message: "Field 'type' has an invalid value."
    });
  }
  for (const field of ["weight", "attenuation_distance"] as const) {
    if (field in sound) {
      requirePositiveInteger(sound[field], unit, diagnostics, {
        code: "rsgl.invalidSoundField",
        message: `Field '${field}' must be a positive integer.`
      });
    }
  }
  for (const field of ["volume", "pitch"] as const) {
    if (field in sound) {
      requirePositiveNumber(sound[field], unit, diagnostics, {
        code: "rsgl.invalidSoundField",
        message: `Field '${field}' must be a positive number.`
      });
    }
  }
  validateBooleanField(sound, "preload", "rsgl.invalidSoundField", unit, diagnostics);
  validateBooleanField(sound, "stream", "rsgl.invalidSoundField", unit, diagnostics);

  if (typeof sound.name !== "string") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.missingSoundName", "Sound object entries must define a string name.");
    return;
  }

  if (sound.type === "event") {
    validateSoundEventReference(sound, namespace, localEvents, unit, diagnostics, generatedPath);
  } else {
    validateSoundFileReference(
      sound,
      "name",
      sound.name,
      unit,
      options,
      diagnostics,
      appendGeneratedPath(generatedPath, "name")
    );
  }
}

function validateSoundFileReference(
  owner: Record<string, JsonValue> | JsonValue[],
  key: string | number,
  value: string,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (/\s/.test(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundReference", "Sound file names must not contain whitespace.", "warning");
  }
  if (/\.ogg$/i.test(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidSoundReference", "Sound file references should omit the .ogg extension.", "warning");
  }

  const checked = checkJsonResourceReference(
    owner,
    key,
    "sound",
    unit,
    options,
    diagnostics,
    generatedPath
  );
  if (!checked.available) {
    return;
  }
  validateSoundMetadata(checked.canonicalId!, unit, options, diagnostics, checked.source);
}

function validateSoundMetadata(
  soundId: string,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  source: ExternResourceSource | undefined
): void {
  const metadataReader = source && options.externSoundMetadata
    ? (id: string) => options.externSoundMetadata!(source, id)
    : options.soundMetadata;
  if (!metadataReader) {
    return;
  }
  const metadata = metadataReader(soundId);
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
  sound: Record<string, JsonValue>,
  namespace: string,
  localEvents: Set<string>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const value = sound.name as string;
  const canonicalId = canonicalizeJsonResourceReference(
    sound,
    "name",
    "sound",
    unit,
    diagnostics,
    appendGeneratedPath(generatedPath, "name"),
    namespace
  );
  const id = canonicalId ? tryParseMinecraftResourceId(canonicalId, namespace) : null;
  if (!id) {
    return;
  }
  if (id.namespace === namespace && !localEvents.has(id.path)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.soundEventNotFound", `Sound event '${value}' is not defined in this sounds resource.`, "warning");
  }
}

function isDeprecatedLangShape(content: Record<string, JsonValue>): boolean {
  const keys = Object.keys(content);
  return keys.length > 0 && keys.every(key => key === "removed" || key === "renamed");
}
