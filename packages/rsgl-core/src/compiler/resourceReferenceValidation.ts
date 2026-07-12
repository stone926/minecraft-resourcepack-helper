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
  kind: RsglResourceExistenceKind,
  id: string,
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit> | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange = unitRange(unit),
  externScopeFile?: string
): RsglCheckedResourceReference {
  if ((kind === "model" && generatedModels?.has(id)) || options.generatedResourceIds?.get(kind)?.has(id)) {
    return { available: true, external: false };
  }
  if (kind === "model" && isVirtualBuiltinModelId(id)) {
    return { available: true, external: false };
  }

  const sourceFile = sourceFileForValidationRange(unit, range);
  const declaration = resolveExternDeclaration(
    kind,
    id,
    externScopeFile ?? sourceFile,
    sourceFile,
    options,
    diagnostics,
    range
  );
  if (!declaration) {
    return { available: false, external: true };
  }

  const skipExistenceCheck = declaration.skipExistenceCheck
    || declaration.checkExistence === false
    || (declaration.checkExistence === undefined && options.checkExternExistence === false);
  const resolvedPath = skipExistenceCheck
    ? null
    : options.externResourcePath?.(declaration.source, kind, id);
  const exists = skipExistenceCheck
    ? true
    : resolvedPath !== undefined
      ? resolvedPath !== null
      : options.externResourceExists
        ? options.externResourceExists(declaration.source, kind, id)
        : (options.resourceExists?.(kind, id) ?? false);
  options.onExternResourceUsed?.({
    source: declaration.source,
    resourceKind: declaration.resourceKind,
    targetKind: kind,
    id,
    skipExistenceCheck,
    sourceFile,
    range,
    ...(resolvedPath ? { resolvedPath } : {})
  });
  if (exists) {
    return { available: true, external: true, source: declaration.source };
  }

  pushResourceDiagnostic(diagnostics, kind, `not found: ${id}`, "warning", range, sourceFile);
  return { available: false, external: true, source: declaration.source };
}

/**
 * Checks a resource referenced by already-loaded external content. Its source
 * is inherited from that content, while the concrete usage is still recorded
 * for manifests and dependency watching.
 */
export function checkInheritedExternalResourceExists(
  kind: RsglResourceExistenceKind,
  id: string,
  source: ExternResourceSource,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  range: ValidationRange,
  fallbackExists: boolean
): boolean {
  if (options.generatedResourceIds?.get(kind)?.has(id)) {
    return true;
  }
  const sourceFile = sourceFileForValidationRange(unit, range);
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
  const sources = new Set(equallySpecific.map(candidate => candidate.source));
  if (sources.size > 1) {
    pushDiagnosticAtRange(
      diagnostics,
      "rsgl.ambiguousExternalResource",
      `${resourceLabel(kind)} '${id}' matches equally specific custom and vanilla extern declarations.`,
      "error",
      range,
      diagnosticFile
    );
    return null;
  }

  return equallySpecific.find(candidate => candidate.skipExistenceCheck) ?? selected;
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
