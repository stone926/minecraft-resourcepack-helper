import { uniqueValues } from "../../../mc-assets/src";
import {
  compareExternPatternSpecificity,
  externResourcePatternMatches,
  type ExternResourceSource,
  type RsglExternDeclaration
} from "../externDeclarations";
import { rsglPathKey } from "../pathIdentity";
import { getExternResourceKindForTargetKind } from "../resourceKinds";
import type { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import {
  pushDiagnosticAtRange,
  sourceFileForValidationRange,
  sourceRangeForGeneratedPath,
  unitRange
} from "./validationDiagnostics";
import type {
  RsglCheckedResourceReference,
  RsglExternalResourceResolution,
  RsglResourceExistenceKind,
  RsglResourceNavigationSourceLocation,
  RsglResourceValidationOptions,
  ValidationRange
} from "./validationTypes";
import {
  canonicalizeResourceReference,
  type RsglResourceReferenceConsumer,
  type RsglResourceReferenceConsumerContext
} from "./resourceReferenceConsumers";
import {
  resourceValueObservationForGeneratedPath,
  validateResourceValueConsumer
} from "./resourceValueValidation";
import {
  cachedExternDeclarationSelection,
  type RsglExternDeclarationSelection
} from "./validationPass";

const virtualVanillaBuiltinModelPrefix = "minecraft:builtin/";
const externSourcePreference = ["local", "custom", "vanilla"] as const;

const resourceDiagnosticPresentation = {
  model: { code: "rsgl.modelNotFound", label: "Model" },
  blockstate: { code: "rsgl.blockstateNotFound", label: "Blockstate" },
  item: { code: "rsgl.itemNotFound", label: "Item" },
  texture: { code: "rsgl.textureNotFound", label: "Texture" },
  textureDirectory: { code: "rsgl.textureDirectoryNotFound", label: "Texture directory" },
  sound: { code: "rsgl.soundNotFound", label: "Sound" },
  font: { code: "rsgl.fontNotFound", label: "Font" },
  fontFile: { code: "rsgl.fontFileNotFound", label: "Font file" },
  shaderVertex: { code: "rsgl.vertexShaderNotFound", label: "Vertex shader" },
  shaderFragment: { code: "rsgl.fragmentShaderNotFound", label: "Fragment shader" }
} satisfies Record<RsglResourceExistenceKind, { code: string; label: string }>;

/** The generated field that supplied the typed resource value being checked. */
export interface RsglResourceValueLocation {
  readonly unit: ResourceUnit;
  readonly generatedPath: string;
}

export function checkResourceExists(
  consumer: RsglResourceReferenceConsumer,
  rawValue: string,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  externScopeFile?: string,
  defaultNamespace: string = unit.id?.namespace ?? "minecraft",
  consumerContext: RsglResourceReferenceConsumerContext = {},
  resourceValueLocation?: RsglResourceValueLocation
): RsglCheckedResourceReference {
  const resourceValueUnit = resourceValueLocation?.unit ?? unit;
  const resourceValueRange = resourceValueLocation
    ? sourceRangeForGeneratedPath(resourceValueUnit, resourceValueLocation.generatedPath)
    : range;
  if (!validateResourceValueConsumer(
    resourceValueUnit,
    consumer,
    diagnostics,
    resourceValueRange,
    resourceValueLocation?.generatedPath
  )) {
    return { available: false, external: false };
  }
  const sourceFile = sourceFileForValidationRange(unit, range);
  const navigationLocation = resourceValueLocation
    ? resourceValueNavigationLocation(
      resourceValueLocation.unit,
      resourceValueLocation.generatedPath
    )
    : undefined;
  const reference = canonicalizeResourceReference(consumer, rawValue, defaultNamespace, consumerContext);
  if (reference.kind === "invalid") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidResourceReference",
      `${resourceLabel(reference.targetKind)} reference '${rawValue}' is not a valid resource location.`,
      "error",
      range,
      sourceFile
    );
    return { available: false, external: false };
  }
  if (reference.kind === "textureVariable") {
    return { available: true, external: false };
  }

  const { id, lookupId, targetKind: kind } = reference;
  options.onResourceReferenceUsed?.({
    targetKind: kind,
    id: lookupId,
    sourceFile,
    range,
    ...(navigationLocation ? { navigationLocation } : {}),
    ...referenceConsumerFacts(
      consumer,
      unit,
      sourceFile,
      range,
      "direct",
      resourceValueLocation?.generatedPath
    )
  });
  if (options.generatedResourceIds?.get(kind)?.has(lookupId)) {
    return { available: true, external: false, canonicalId: id, lookupId };
  }
  if (kind === "model" && isVirtualBuiltinModelId(lookupId)) {
    return { available: true, external: false, canonicalId: id, lookupId };
  }

  const declarationSelection = resolveExternDeclaration(
    kind,
    lookupId,
    externScopeFile ?? sourceFile,
    sourceFile,
    options,
    diagnostics,
    range
  );
  if (!declarationSelection) {
    return { available: false, external: true, canonicalId: id, lookupId };
  }

  const resolved = resolveDeclaredExternalResource(
    declarationSelection,
    options,
    kind,
    lookupId
  );
  const { declaration, skipExistenceCheck, resolvedPath, exists } = resolved;
  options.onExternResourceUsed?.({
    source: declaration.source,
    resolutionScope: declaration.source,
    resourceKind: declaration.resourceKind,
    targetKind: kind,
    id: lookupId,
    skipExistenceCheck,
    sourceFile,
    range,
    ...(navigationLocation ? { navigationLocation } : {}),
    ...referenceConsumerFacts(
      consumer,
      unit,
      sourceFile,
      range,
      "direct",
      resourceValueLocation?.generatedPath
    ),
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(resolved.candidatePaths.length
      ? { candidatePaths: resolved.candidatePaths }
      : {}),
    ...(resolved.metadataPaths.length
      ? { metadataPaths: resolved.metadataPaths }
      : {})
  });
  if (exists) {
    return {
      available: true,
      external: true,
      canonicalId: id,
      lookupId,
      source: declaration.source,
      ...(resolvedPath ? { resolvedPath } : {}),
      ...(resolved.candidatePaths.length ? { candidatePaths: resolved.candidatePaths } : {}),
      ...(resolved.metadataPaths.length ? { metadataPaths: resolved.metadataPaths } : {})
    };
  }

  pushResourceDiagnostic(diagnostics, kind, `not found: ${lookupId}`, "warning", range, sourceFile);
  return {
    available: false,
    external: true,
    canonicalId: id,
    lookupId,
    source: declaration.source,
    ...(resolved.candidatePaths.length ? { candidatePaths: resolved.candidatePaths } : {}),
    ...(resolved.metadataPaths.length ? { metadataPaths: resolved.metadataPaths } : {})
  };
}

/**
 * Checks a resource referenced by already-loaded external content. Minecraft
 * resolves that reference against the effective pack stack independently of
 * the layer that supplied the containing document.
 */
export function checkInheritedExternalResourceExists(
  consumer: RsglResourceReferenceConsumer,
  rawValue: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  fallbackExists: boolean,
  defaultNamespace: string = unit.id?.namespace ?? "minecraft",
  consumerContext: RsglResourceReferenceConsumerContext = {}
): boolean {
  const sourceFile = sourceFileForValidationRange(unit, range);
  const reference = canonicalizeResourceReference(consumer, rawValue, defaultNamespace, consumerContext);
  if (reference.kind === "invalid") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.invalidResourceReference",
      `${resourceLabel(reference.targetKind)} reference '${rawValue}' is not a valid resource location.`,
      "error",
      range,
      sourceFile
    );
    return false;
  }
  if (reference.kind === "textureVariable") {
    return true;
  }
  const { lookupId: id, targetKind: kind } = reference;
  options.onResourceReferenceUsed?.({
    targetKind: kind,
    id,
    sourceFile,
    range,
    ...referenceConsumerFacts(consumer, unit, sourceFile, range, "inherited")
  });
  if (options.generatedResourceIds?.get(kind)?.has(id) || (kind === "model" && isVirtualBuiltinModelId(id))) {
    return true;
  }
  const usesEffectiveResolution = options.resourceResolution !== undefined;
  const skipExistenceCheck = options.checkExternExistence === false;
  const resolution = skipExistenceCheck
    ? undefined
    : options.resourceResolution
      ? options.resourceResolution(kind, id)
      : resolveExternalResource(options, source, kind, id);
  const resolvedPath = skipExistenceCheck ? null : resolution?.resolvedPath;
  const exists = skipExistenceCheck
    ? true
    : resolution !== undefined
      ? resolution.resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(source, kind, id)
        : options.resourceExists
          ? options.resourceExists(kind, id)
          : fallbackExists;
  const resolvedSource = resolution?.source ?? source;
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (resourceKind) {
    options.onExternResourceUsed?.({
      source: resolvedSource,
      resolutionScope: usesEffectiveResolution ? "effective" : source,
      resourceKind,
      targetKind: kind,
      id,
      skipExistenceCheck,
      sourceFile,
      range,
      ...referenceConsumerFacts(consumer, unit, sourceFile, range, "inherited"),
      ...(resolvedPath ? { resolvedPath } : {}),
      ...(resolution?.candidatePaths.length
        ? { candidatePaths: resolution.candidatePaths }
        : {}),
      ...(resolution?.metadataPaths?.length
        ? { metadataPaths: resolution.metadataPaths }
        : {})
    });
  }
  if (!exists) {
    pushResourceDiagnostic(diagnostics, kind, `not found: ${id}`, "warning", range, sourceFile);
  }
  return exists;
}

export function isVirtualBuiltinModelId(id: string): boolean {
  return id.startsWith(virtualVanillaBuiltinModelPrefix);
}

export function resourceNotFoundCode(kind: RsglResourceExistenceKind): string {
  return resourceDiagnosticPresentation[kind].code;
}

export function resourceLabel(kind: RsglResourceExistenceKind): string {
  return resourceDiagnosticPresentation[kind].label;
}

function resolveExternDeclaration(
  kind: RsglResourceExistenceKind,
  id: string,
  externScopeFile: string,
  diagnosticFile: string,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange
): Extract<RsglExternDeclarationSelection, { kind: "selected" }> | null {
  const normalizedScopeFile = normalizeValidationFileName(externScopeFile);
  const selection = cachedExternDeclarationSelection(
    options,
    kind,
    id,
    normalizedScopeFile,
    () => selectExternDeclaration(kind, id, normalizedScopeFile, options.externDeclarations ?? [])
  );
  if (selection.kind === "unsupported") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.undeclaredExternalResource",
      `${resourceLabel(kind)} '${id}' cannot be declared by any supported extern kind.`,
      "error",
      range,
      diagnosticFile
    );
    return null;
  }
  if (selection.kind === "undeclared") {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.undeclaredExternalResource",
      `${resourceLabel(kind)} '${id}' is external and must be declared with extern in ${externScopeFile} or rsgl.config.json.`,
      "error",
      range,
      diagnosticFile
    );
    return null;
  }
  return selection;
}

function selectExternDeclaration(
  kind: RsglResourceExistenceKind,
  id: string,
  normalizedScopeFile: string,
  declarations: readonly RsglExternDeclaration[]
): RsglExternDeclarationSelection {
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (!resourceKind) {
    return { kind: "unsupported" };
  }

  const matches = declarations.filter(declaration =>
    declaration.resourceKind === resourceKind
    && externResourcePatternMatches(declaration.pattern, id)
  );
  const localMatches = matches.filter(declaration =>
    declaration.fileName !== undefined
    && normalizeValidationFileName(declaration.fileName) === normalizedScopeFile
  );
  const candidates = localMatches.length > 0
    ? localMatches
    : matches.filter(declaration => declaration.fileName === undefined);
  if (candidates.length === 0) {
    return { kind: "undeclared" };
  }

  const preferredBySource = externSourcePreference.flatMap(source => {
    const sourceCandidates = candidates.filter(candidate => candidate.source === source);
    if (sourceCandidates.length === 0) {
      return [];
    }
    const sorted = sourceCandidates.sort((left, right) =>
      compareExternPatternSpecificity(right.pattern, left.pattern)
    );
    const mostSpecific = sorted[0];
    const equallySpecific = sorted.filter(candidate =>
      compareExternPatternSpecificity(candidate.pattern, mostSpecific.pattern) === 0
    );
    return [equallySpecific.find(candidate => candidate.skipExistenceCheck) ?? mostSpecific];
  });
  preferredBySource.sort(compareExternDeclarationPreference);
  const [declaration, ...fallbackDeclarations] = preferredBySource;
  return {
    kind: "selected",
    declaration,
    fallbackDeclarations
  };
}

interface ResolvedDeclaredExternalResource {
  declaration: RsglExternDeclaration;
  skipExistenceCheck: boolean;
  resolvedPath: string | null;
  exists: boolean;
  candidatePaths: string[];
  metadataPaths: string[];
}

/**
 * Resolves the preferred extern declaration, then falls back only across other
 * explicitly declared physical sources. A broader declaration from the same
 * source cannot weaken a more-specific checked declaration.
 */
function resolveDeclaredExternalResource(
  selection: Extract<RsglExternDeclarationSelection, { kind: "selected" }>,
  options: RsglResourceValidationOptions,
  kind: RsglResourceExistenceKind,
  id: string
): ResolvedDeclaredExternalResource {
  const attempts: Array<{
    declaration: RsglExternDeclaration;
    skipExistenceCheck: boolean;
    resolution?: RsglExternalResourceResolution;
    exists: boolean;
  }> = [];
  const primarySourcePriority = externSourcePreference.indexOf(selection.declaration.source);
  const fallbackDeclarations = selection.fallbackDeclarations.filter(declaration =>
    externSourcePreference.indexOf(declaration.source) < primarySourcePriority
  ).sort((left, right) =>
    externSourcePreference.indexOf(left.source) - externSourcePreference.indexOf(right.source)
  );
  for (const [index, declaration] of [selection.declaration, ...fallbackDeclarations].entries()) {
    const skipExistenceCheck = declaration.skipExistenceCheck
      || declaration.checkExistence === false
      || (declaration.checkExistence === undefined && options.checkExternExistence === false);
    // A checked declaration may discover a concrete higher pack-layer override.
    // It must not fall through to an unchecked declaration and silently weaken
    // the existence guarantee selected by the more-specific pattern.
    if (index > 0 && skipExistenceCheck) {
      continue;
    }
    const resolution = skipExistenceCheck
      ? undefined
      : resolveExternalResource(options, declaration.source, kind, id);
    const exists = skipExistenceCheck
      ? true
      : resolution !== undefined
        ? resolution.resolvedPath !== null
        : options.externResourceExists
          ? options.externResourceExists(declaration.source, kind, id)
          : (options.resourceExists?.(kind, id) ?? false);
    attempts.push({ declaration, skipExistenceCheck, resolution, exists });
    if (exists) {
      break;
    }
  }

  const chosen = attempts.find(attempt => attempt.exists) ?? attempts[0];
  return {
    declaration: chosen.declaration,
    skipExistenceCheck: chosen.skipExistenceCheck,
    resolvedPath: chosen.skipExistenceCheck ? null : chosen.resolution?.resolvedPath ?? null,
    exists: chosen.exists,
    candidatePaths: uniqueValues(attempts.flatMap(attempt => attempt.resolution?.candidatePaths ?? [])),
    metadataPaths: uniqueValues(attempts.flatMap(attempt => attempt.resolution?.metadataPaths ?? []))
  };
}

function compareExternDeclarationPreference(
  left: RsglExternDeclaration,
  right: RsglExternDeclaration
): number {
  const specificity = compareExternPatternSpecificity(right.pattern, left.pattern);
  if (specificity !== 0) {
    return specificity;
  }
  return externSourcePreference.indexOf(left.source) - externSourcePreference.indexOf(right.source);
}

function pushResourceDiagnostic(
  diagnostics: RsglCompileDiagnostic[],
  kind: RsglResourceExistenceKind,
  messageSuffix: string,
  severity: RsglCompileDiagnostic["severity"],
  range: ValidationRange,
  fileName: string
): void {
  pushDiagnosticAtRange(
    diagnostics,
    resourceNotFoundCode(kind),
    `${resourceLabel(kind)} ${messageSuffix}`,
    severity,
    range,
    fileName
  );
}

function normalizeValidationFileName(fileName: string): string {
  return rsglPathKey(fileName);
}

function resourceValueNavigationLocation(
  unit: ResourceUnit,
  generatedPath: string
): RsglResourceNavigationSourceLocation | undefined {
  const observation = resourceValueObservationForGeneratedPath(unit, generatedPath);
  if (!observation) {
    return undefined;
  }
  const range = observation.valueLocation?.range ?? observation.range;
  return {
    sourceFile: observation.valueLocation?.sourceFile
      ?? observation.sourceFile
      ?? sourceFileForValidationRange(unit, observation.range),
    range
  };
}

function resolveExternalResource(
  options: RsglResourceValidationOptions,
  source: ExternResourceSource,
  kind: RsglResourceExistenceKind,
  id: string
): RsglExternalResourceResolution | undefined {
  const resolution = options.externResourceResolution?.(source, kind, id);
  if (resolution) {
    return resolution;
  }
  const resolvedPath = options.externResourcePath?.(source, kind, id);
  return resolvedPath === undefined
    ? undefined
    : {
        resolvedPath,
        candidatePaths: resolvedPath ? [resolvedPath] : []
      };
}

function referenceConsumerFacts(
  consumer: RsglResourceReferenceConsumer,
  unit: ResourceUnit,
  sourceFile: string,
  range: ValidationRange,
  origin: "direct" | "inherited",
  sourceGeneratedPath?: string
): Pick<
  import("./validationTypes").RsglResourceReferenceUsage,
  | "consumerOutputPath"
  | "consumerKind"
  | "consumerId"
  | "consumer"
  | "sourceGeneratedPath"
  | "origin"
> {
  const generatedPath = sourceGeneratedPath
    ?? unit.validation?.referenceOrigins?.find(candidate =>
      candidate.sourceFile === sourceFile
      && candidate.sourceRange.start === range.start
      && candidate.sourceRange.end === range.end
    )?.generatedPath;
  return {
    consumerOutputPath: unit.outputPath,
    consumerKind: unit.kind,
    ...(unit.id ? { consumerId: `${unit.id.namespace}:${unit.id.path}` } : {}),
    consumer,
    ...(generatedPath === undefined ? {} : { sourceGeneratedPath: generatedPath }),
    origin
  };
}
