import { isExternalResourceUnit, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { getRsglResourceKindDescriptor, RsglResourceValidationHandler } from "../resourceKinds";
import { validateAtlasUnit } from "./atlasValidation";
import { validateBlockstateUnit } from "./blockstateJsonValidation";
import { validateFontMetadata } from "./fontValidation";
import { validateItemModelDefinition, validateItemTopLevelFields } from "./itemDefinitionValidation";
import { validateLangMetadata, validateSoundsMetadata } from "./langSoundsValidation";
import { validateMcmetaMetadata } from "./mcmetaValidation";
import { createModelResolver, validateModelUnit } from "./modelReferenceValidation";
import { validatePackMetadata } from "./packMetadataValidation";
import { validateEquipmentUnit, validateParticlesUnit } from "./particlesEquipmentValidation";
import { validatePostEffectMetadata } from "./postEffectValidation";
import {
  asObject,
  attachSourceFile,
  checkResourceExists,
  resourceLabel,
  resourceNotFoundCode,
  unitRange,
  type RsglResourceValidationOptions
} from "./validationShared";
import { validateWaypointStyleMetadata } from "./waypointStyleValidation";

export type {
  RsglResourceContentKind,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  RsglSoundMetadata,
  RsglTextureMetadata
} from "./validationShared";

interface ResourceValidationContext {
  generatedModels: Map<string, ResourceUnit>;
  generatedFonts: Set<string>;
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
    validateModelUnit(unit, context.generatedModels, context.modelResolver, options, diagnostics),
  item: (unit, context, options, diagnostics) =>
    validateItemUnit(unit, context.generatedModels, options, diagnostics),
  blockstate: (unit, context, options, diagnostics) =>
    validateBlockstateUnit(unit, context.generatedModels, options, diagnostics),
  sounds: (unit, _context, options, diagnostics) => validateSoundsUnit(unit, options, diagnostics),
  lang: (unit, _context, _options, diagnostics) => validateLangUnit(unit, diagnostics),
  atlas: (unit, _context, options, diagnostics) => validateAtlasUnit(unit, options, diagnostics),
  mcmeta: (unit, _context, options, diagnostics) => validateMcmetaUnit(unit, options, diagnostics),
  particles: (unit, _context, options, diagnostics) => validateParticlesUnit(unit, options, diagnostics),
  equipment: (unit, _context, options, diagnostics) => validateEquipmentUnit(unit, options, diagnostics),
  font: (unit, context, options, diagnostics) => validateFontUnit(unit, context.generatedFonts, options, diagnostics),
  waypointStyle: (unit, _context, options, diagnostics) => validateWaypointStyleUnit(unit, options, diagnostics),
  postEffect: (unit, _context, options, diagnostics) => validatePostEffectUnit(unit, options, diagnostics),
  pack: (unit, _context, options, diagnostics) => validatePackUnit(unit, options, diagnostics)
} satisfies Record<Exclude<RsglResourceValidationHandler, "none">, ResourceValidator>;

export function validateResourceUnits(
  units: ResourceUnit[],
  options: RsglResourceValidationOptions = {}
): RsglCompileDiagnostic[] {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const generatedModels = new Map(
    units
      .filter(unit => unit.kind === "model" && unit.id)
      .map(unit => [`${unit.id!.namespace}:${unit.id!.path}`, unit])
  );
  const generatedFonts = new Set(
    units
      .filter(unit => unit.kind === "font" && unit.id)
      .map(unit => `${unit.id!.namespace}:${unit.id!.path}`)
  );
  const modelResolver = createModelResolver(generatedModels, options);
  const validationContext: ResourceValidationContext = { generatedModels, generatedFonts, modelResolver };

  for (const unit of units) {
    const diagnosticStart = diagnostics.length;
    if (isExternalResourceUnit(unit)) {
      validateExternalResourceUnit(unit, options, diagnostics);
    } else {
      const validationHandler = getRsglResourceKindDescriptor(unit.kind)?.validation.handler ?? "none";
      if (validationHandler !== "none") {
        resourceValidators[validationHandler](unit, validationContext, options, diagnostics);
      }
    }
    attachSourceFile(diagnostics, diagnosticStart, unit.sourceMap.mappings[0]?.sourceFile);
  }

  return diagnostics;
}

function validateExternalResourceUnit(
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!unit.external || !options.resourceExists) {
    return;
  }
  if (options.resourceExists(unit.external.resourceKind, unit.external.id)) {
    return;
  }
  diagnostics.push({
    code: resourceNotFoundCode(unit.external.resourceKind),
    message: `${resourceLabel(unit.external.resourceKind)} not found: ${unit.external.id}`,
    severity: "warning",
    range: unitRange(unit)
  });
}

function validateItemUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  validateItemTopLevelFields(content, unit, diagnostics, "");
  validateItemModelDefinition(content?.model, unit, generatedModels, options, diagnostics, "/model");
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
  if (textureId) {
    checkResourceExists("texture", textureId, unit, undefined, options, diagnostics);
  }
  validateMcmetaMetadata(unit, textureId, options, diagnostics);
}

function validateFontUnit(
  unit: ResourceUnit,
  generatedFonts: Set<string>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateFontMetadata(unit, generatedFonts, options, diagnostics);
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
