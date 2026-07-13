import { isExternalResourceUnit, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { getRsglResourceKindDescriptor, RsglResourceValidationHandler } from "../resourceKinds";
import { validateAtlasUnit } from "./atlasValidation";
import { validateBlockstateUnit } from "./blockstateJsonValidation";
import { validateFontMetadata } from "./fontValidation";
import { validateItemModelDefinition, validateItemTopLevelFields } from "./itemDefinitionValidation";
import { validateLangMetadata, validateSoundsMetadata } from "./langSoundsValidation";
import { validateMcmetaMetadata } from "./mcmetaValidation";
import { validateModelUnit } from "./modelReferenceValidation";
import { createModelResolver } from "./modelDocuments";
import { validatePackMetadata } from "./packMetadataValidation";
import { validateEquipmentUnit, validateParticlesUnit } from "./particlesEquipmentValidation";
import { validatePostEffectMetadata } from "./postEffectValidation";
import { checkResourceExists } from "./resourceReferenceValidation";
import { sourceFileForValidationRange, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import { asObject } from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
import { validateWaypointStyleMetadata } from "./waypointStyleValidation";
import { createGeneratedResourceIndex } from "./generatedResources";

export type {
  RsglExternalResourceUsage,
  RsglResourceContentKind,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  RsglSoundMetadata,
  RsglTextureMetadata
} from "./validationTypes";

interface ResourceValidationContext {
  modelResolver: ReturnType<typeof createModelResolver>;
}

type ResourceValidator = (
  unit: ResourceUnit,
  context: ResourceValidationContext,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
) => void;

const resourceValidators = {
  model: (unit, context, options, diagnostics) =>
    validateModelUnit(unit, context.modelResolver, options, diagnostics),
  item: (unit, _context, options, diagnostics) =>
    validateItemUnit(unit, options, diagnostics),
  blockstate: (unit, _context, options, diagnostics) =>
    validateBlockstateUnit(unit, options, diagnostics),
  sounds: (unit, _context, options, diagnostics) => validateSoundsUnit(unit, options, diagnostics),
  lang: (unit, _context, _options, diagnostics) => validateLangUnit(unit, diagnostics),
  atlas: (unit, _context, options, diagnostics) => validateAtlasUnit(unit, options, diagnostics),
  mcmeta: (unit, _context, options, diagnostics) => validateMcmetaUnit(unit, options, diagnostics),
  particles: (unit, _context, options, diagnostics) => validateParticlesUnit(unit, options, diagnostics),
  equipment: (unit, _context, options, diagnostics) => validateEquipmentUnit(unit, options, diagnostics),
  font: (unit, _context, options, diagnostics) => validateFontUnit(unit, options, diagnostics),
  waypointStyle: (unit, _context, options, diagnostics) => validateWaypointStyleUnit(unit, options, diagnostics),
  postEffect: (unit, _context, options, diagnostics) => validatePostEffectUnit(unit, options, diagnostics),
  pack: (unit, _context, options, diagnostics) => validatePackUnit(unit, options, diagnostics)
} satisfies Record<Exclude<RsglResourceValidationHandler, "none">, ResourceValidator>;

/**
 * Canonicalizes every schema-known resource reference in place, then validates
 * the resulting units. Compile output intentionally uses the mutated content.
 */
export function canonicalizeAndValidateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const generatedModels = new Map(
    units
      .filter(unit => unit.kind === "model" && unit.id && !isExternalResourceUnit(unit))
      .map(unit => [`${unit.id!.namespace}:${unit.id!.path}`, unit])
  );
  const validationOptions = {
    ...options,
    generatedResourceIds: createGeneratedResourceIndex(units)
  };
  const modelResolver = createModelResolver(generatedModels, validationOptions);
  const validationContext: ResourceValidationContext = { modelResolver };

  for (const unit of units) {
    const diagnosticStart = diagnostics.length;
    if (isExternalResourceUnit(unit)) {
      continue;
    } else {
      const validationHandler = getRsglResourceKindDescriptor(unit.kind)?.validation.handler ?? "none";
      if (validationHandler !== "none") {
        resourceValidators[validationHandler](unit, validationContext, validationOptions, diagnostics);
      }
    }
    for (const diagnostic of diagnostics.slice(diagnosticStart)) {
      diagnostic.fileName ??= sourceFileForValidationRange(unit, diagnostic.range);
    }
  }

  return diagnostics;
}

/** Compatibility facade; validation of known reference sinks is canonicalizing. */
export function validateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  return canonicalizeAndValidateResourceUnits(units, options);
}

function validateItemUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  validateItemTopLevelFields(content, unit, diagnostics, "");
  validateItemModelDefinition(content?.model, unit, options, diagnostics, "/model");
}

function validateSoundsUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateSoundsMetadata(unit, options, diagnostics);
}

function validateLangUnit(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateLangMetadata(unit, diagnostics);
}

function validateMcmetaUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const textureId = textureIdFromMcmetaOutputPath(unit.outputPath);
  const checked = textureId
    ? checkResourceExists(
      "texture",
      textureId,
      unit,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, "/@resource-id")
    )
    : undefined;
  const metadataOptions = checked?.source && options.externTextureMetadata
    ? { ...options, textureMetadata: (id: string) => options.externTextureMetadata!(checked.source!, id) }
    : options;
  validateMcmetaMetadata(unit, textureId, metadataOptions, diagnostics);
}

function validateFontUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateFontMetadata(unit, options, diagnostics);
}

function validateWaypointStyleUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateWaypointStyleMetadata(unit, options, diagnostics);
}

function validatePostEffectUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validatePostEffectMetadata(unit, options, diagnostics);
}

function validatePackUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validatePackMetadata(unit, options, diagnostics);
}

function textureIdFromMcmetaOutputPath(outputPath: string): string | null {
  const match = /^assets\/([^/]+)\/textures\/(.+)\.png\.mcmeta$/.exec(outputPath.replace(/\\/g, "/"));
  return match ? `${match[1]}:${match[2]}` : null;
}
