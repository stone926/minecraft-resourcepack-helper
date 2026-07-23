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
  RsglResourceValidationOptions,
  ValidationRange
} from "./validationTypes";
import {
  canonicalizeResourceReference,
  type RsglResourceReferenceConsumer,
  type RsglResourceReferenceConsumerContext
} from "./resourceReferenceConsumers";
import { validateResourceValueConsumer } from "./resourceValueValidation";
import {
  cachedExternDeclarationSelection,
  type RsglExternDeclarationSelection
} from "./validationPass";

const virtualVanillaBuiltinModelPrefix = "minecraft:builtin/";

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

  const declaration = resolveExternDeclaration(
    kind,
    lookupId,
    externScopeFile ?? sourceFile,
    sourceFile,
    options,
    diagnostics,
    range
  );
  if (!declaration) {
    return { available: false, external: true, canonicalId: id, lookupId };
  }

  const skipExistenceCheck = declaration.skipExistenceCheck
    || declaration.checkExistence === false
    || (declaration.checkExistence === undefined && options.checkExternExistence === false);
  const resolution = skipExistenceCheck
    ? undefined
    : resolveExternalResource(options, declaration.source, kind, lookupId);
  const resolvedPath = skipExistenceCheck ? null : resolution?.resolvedPath;
  const exists = skipExistenceCheck
    ? true
    : resolution !== undefined
      ? resolution.resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(declaration.source, kind, lookupId)
        : (options.resourceExists?.(kind, lookupId) ?? false);
  options.onExternResourceUsed?.({
    source: declaration.source,
    resourceKind: declaration.resourceKind,
    targetKind: kind,
    id: lookupId,
    skipExistenceCheck,
    sourceFile,
    range,
    ...referenceConsumerFacts(
      consumer,
      unit,
      sourceFile,
      range,
      "direct",
      resourceValueLocation?.generatedPath
    ),
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(resolution?.candidatePaths.length
      ? { candidatePaths: resolution.candidatePaths }
      : {}),
    ...(resolution?.metadataPaths?.length
      ? { metadataPaths: resolution.metadataPaths }
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
      ...(resolution ? { candidatePaths: resolution.candidatePaths } : {}),
      ...(resolution?.metadataPaths ? { metadataPaths: resolution.metadataPaths } : {})
    };
  }

  pushResourceDiagnostic(diagnostics, kind, `not found: ${lookupId}`, "warning", range, sourceFile);
  return {
    available: false,
    external: true,
    canonicalId: id,
    lookupId,
    source: declaration.source,
    ...(resolution ? { candidatePaths: resolution.candidatePaths } : {}),
    ...(resolution?.metadataPaths ? { metadataPaths: resolution.metadataPaths } : {})
  };
}

/**
 * Checks a resource referenced by already-loaded external content. Its source
 * is inherited from that content, while the concrete usage is still recorded
 * for manifests and dependency watching.
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
  const skipExistenceCheck = options.checkExternExistence === false;
  const resolution = skipExistenceCheck
    ? undefined
    : resolveExternalResource(options, source, kind, id);
  const resolvedPath = skipExistenceCheck ? null : resolution?.resolvedPath;
  const exists = skipExistenceCheck
    ? true
    : resolution !== undefined
      ? resolution.resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(source, kind, id)
        : (options.resourceExists?.(kind, id) ?? fallbackExists);
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (resourceKind) {
    options.onExternResourceUsed?.({
      source,
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
): RsglExternDeclaration | null {
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
  return selection.declaration;
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

  const sorted = [...candidates].sort((left, right) =>
    compareExternPatternSpecificity(right.pattern, left.pattern)
  );
  const selected = sorted[0];
  const equallySpecific = sorted.filter(candidate =>
    compareExternPatternSpecificity(candidate.pattern, selected.pattern) === 0
  );
  const preferredSource = (["local", "custom", "vanilla"] as const)
    .find(source => equallySpecific.some(candidate => candidate.source === source));
  const sourceCandidates = preferredSource
    ? equallySpecific.filter(candidate => candidate.source === preferredSource)
    : equallySpecific;
  return {
    kind: "selected",
    declaration: sourceCandidates.find(candidate => candidate.skipExistenceCheck) ?? sourceCandidates[0]
  };
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
