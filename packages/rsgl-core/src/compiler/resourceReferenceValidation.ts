import {
  compareExternPatternSpecificity,
  externResourcePatternMatches,
  type ExternResourceSource,
  type RsglExternDeclaration
} from "../externDeclarations";
import { getExternResourceKindForTargetKind } from "../resourceKinds";
import type { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { pushDiagnosticAtRange, sourceFileForValidationRange, unitRange } from "./validationDiagnostics";
import type {
  RsglCheckedResourceReference,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  ValidationRange
} from "./validationTypes";
import {
  canonicalizeResourceReference,
  type RsglResourceReferenceConsumer,
  type RsglResourceReferenceConsumerContext
} from "./resourceReferenceConsumers";

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

export function checkResourceExists(
  consumer: RsglResourceReferenceConsumer,
  rawValue: string,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  externScopeFile?: string,
  defaultNamespace: string = unit.id?.namespace ?? "minecraft",
  consumerContext: RsglResourceReferenceConsumerContext = {}
): RsglCheckedResourceReference {
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
  const resolvedPath = skipExistenceCheck
    ? null
    : options.externResourcePath?.(declaration.source, kind, lookupId);
  const exists = skipExistenceCheck
    ? true
    : resolvedPath !== undefined
      ? resolvedPath !== null
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
    ...(resolvedPath ? { resolvedPath } : {})
  });
  if (exists) {
    return { available: true, external: true, canonicalId: id, lookupId, source: declaration.source };
  }

  pushResourceDiagnostic(diagnostics, kind, `not found: ${lookupId}`, "warning", range, sourceFile);
  return { available: false, external: true, canonicalId: id, lookupId, source: declaration.source };
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
  if (options.generatedResourceIds?.get(kind)?.has(id) || (kind === "model" && isVirtualBuiltinModelId(id))) {
    return true;
  }
  const skipExistenceCheck = options.checkExternExistence === false;
  const resolvedPath = skipExistenceCheck
    ? null
    : options.externResourcePath?.(source, kind, id);
  const exists = skipExistenceCheck
    ? true
    : resolvedPath !== undefined
      ? resolvedPath !== null
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
      ...(resolvedPath ? { resolvedPath } : {})
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
  const resourceKind = getExternResourceKindForTargetKind(kind);
  if (!resourceKind) {
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

  const matches = (options.externDeclarations ?? []).filter(declaration =>
    declaration.resourceKind === resourceKind
    && externResourcePatternMatches(declaration.pattern, id)
  );
  const normalizedSourceFile = normalizeValidationFileName(externScopeFile);
  const localMatches = matches.filter(declaration =>
    declaration.fileName !== undefined
    && normalizeValidationFileName(declaration.fileName) === normalizedSourceFile
  );
  const candidates = localMatches.length > 0
    ? localMatches
    : matches.filter(declaration => declaration.fileName === undefined);
  if (candidates.length === 0) {
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

  const sorted = [...candidates].sort((left, right) =>
    compareExternPatternSpecificity(right.pattern, left.pattern)
  );
  const selected = sorted[0];
  const equallySpecific = sorted.filter(candidate =>
    compareExternPatternSpecificity(candidate.pattern, selected.pattern) === 0
  );
  const customCandidates = equallySpecific.filter(candidate => candidate.source === "custom");
  const sourceCandidates = customCandidates.length > 0 ? customCandidates : equallySpecific;
  return sourceCandidates.find(candidate => candidate.skipExistenceCheck) ?? sourceCandidates[0];
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
  const normalized = fileName.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
