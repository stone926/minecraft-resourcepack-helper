import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePathKey } from "../../mc-assets/src";
import {
  compileOptionsFromProjectConfig,
  isRsglPathInsideOrEqual,
  loadRsglProjectConfigForSource,
  normalizeRsglFormattingConfiguration,
  projectCompileOptionsFromRsglConfig,
  resolveRsglCompileConfiguration,
  resolveRsglOutputPackRoot,
  type RsglCompileConfigurationOptions,
  type RsglFormattingConfiguration,
  type RsglProgramCompileOptions,
  type RsglResourceValidationOptions,
  type RsglWorkspaceValidationCache,
  type RsglWorkspaceValidationCallbacks
} from "../../rsgl-core/src";
import type { RsglResourceSnapshotRequest } from "../../rsgl-shared/src";
import type { RsglResourceAnalysisConfiguration } from "./resourceAnalysisCache";
import {
  fileNameFromSerializedResourceUri,
  type RsglResourceUriNativePathMapping
} from "./resourceSnapshotUris";

/** Validation settings pushed by the client via initializationOptions or didChangeConfiguration. */
export interface RsglValidationSettings {
  stdlibRoot?: string;
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
  formatting?: RsglFormattingConfiguration;
  workspaceFolders?: readonly RsglWorkspaceFolderValidationSettings[];
}

export interface RsglWorkspaceFolderValidationSettings {
  workspaceFolderUri?: string;
  workspaceFolderPath: string;
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
  formatting?: RsglFormattingConfiguration;
}

type RsglWorkspaceAnalysisOptions = RsglWorkspaceValidationCallbacks
  & RsglResourceValidationOptions
  & RsglCompileConfigurationOptions
  & Pick<RsglProgramCompileOptions, "stdlibRoot">;

/** Filesystem-relevant subset of LSP initialization parameters. */
export interface RsglWorkspaceInitializationParams {
  workspaceFolders?: readonly { uri: string }[] | null;
  rootUri?: string | null;
  rootPath?: string | null;
}

/** Normalizes an untyped settings payload into safe validation settings. */
export function toValidationSettings(value: unknown): RsglValidationSettings {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const stdlibRoot = typeof record.stdlibRoot === "string" && record.stdlibRoot.trim().length > 0
    ? path.resolve(record.stdlibRoot)
    : undefined;
  const defaultAssetsPath = typeof record.defaultAssetsPath === "string"
    && record.defaultAssetsPath.trim().length > 0
    ? record.defaultAssetsPath
    : null;
  const roots = record.resourcePackRoots;
  const resourcePackRoots = Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
  const hasFormatting = Object.prototype.hasOwnProperty.call(record, "formatting");
  const formatting = hasFormatting
    ? normalizeRsglFormattingConfiguration(record.formatting)
    : undefined;
  const workspaceFolders = Array.isArray(record.workspaceFolders)
    ? record.workspaceFolders.flatMap(value => {
      if (typeof value !== "object" || value === null) {
        return [];
      }
      const folder = value as Record<string, unknown>;
      if (
        typeof folder.workspaceFolderPath !== "string"
        || folder.workspaceFolderPath.trim().length === 0
      ) {
        return [];
      }
      const folderDefaultAssetsPath = typeof folder.defaultAssetsPath === "string"
        && folder.defaultAssetsPath.trim().length > 0
        ? folder.defaultAssetsPath
        : null;
      const folderRoots = Array.isArray(folder.resourcePackRoots)
        ? folder.resourcePackRoots.filter((root): root is string => typeof root === "string")
        : [];
      const hasFolderFormatting = Object.prototype.hasOwnProperty.call(folder, "formatting");
      return [{
        ...(isSerializedWorkspaceUri(folder.workspaceFolderUri)
          ? { workspaceFolderUri: folder.workspaceFolderUri }
          : {}),
        workspaceFolderPath: path.resolve(folder.workspaceFolderPath),
        defaultAssetsPath: folderDefaultAssetsPath,
        resourcePackRoots: folderRoots,
        ...(hasFolderFormatting
          ? { formatting: normalizeRsglFormattingConfiguration(folder.formatting) }
          : {})
      }];
    })
    : [];
  return {
    ...(stdlibRoot ? { stdlibRoot } : {}),
    defaultAssetsPath,
    resourcePackRoots,
    ...(formatting ? { formatting } : {}),
    ...(workspaceFolders.length > 0 ? { workspaceFolders } : {})
  };
}

/**
 * Creates the identity of settings that affect semantic and resource analysis.
 * Formatting is intentionally excluded so style-only changes stay cheap.
 */
export function validationSettingsFingerprint(settings: RsglValidationSettings): string {
  return JSON.stringify({
    stdlibRoot: settings.stdlibRoot ?? null,
    defaultAssetsPath: settings.defaultAssetsPath,
    resourcePackRoots: settings.resourcePackRoots,
    workspaceFolders: (settings.workspaceFolders ?? []).map(folder => ({
      workspaceFolderUri: folder.workspaceFolderUri ?? null,
      workspaceFolderPath: folder.workspaceFolderPath,
      defaultAssetsPath: folder.defaultAssetsPath,
      resourcePackRoots: folder.resourcePackRoots
    }))
  });
}

function isSerializedWorkspaceUri(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    && !/^[a-zA-Z]:[\\/]/.test(value);
}

export interface RsglSemanticWatchBatchCallbacks {
  invalidatePath(fileName: string): void;
  invalidateProjectConfiguration?(): void;
  refresh?(): void;
}

/** Applies configuration and RSGL source watcher changes as one semantic batch. */
export function handleSemanticWatchedFileBatch(
  changedFileNames: readonly string[],
  callbacks: RsglSemanticWatchBatchCallbacks
): boolean {
  const rsglChanges = new Set<string>();
  let configurationChanged = false;
  for (const fileName of changedFileNames) {
    if (path.basename(fileName).toLowerCase() === "rsgl.config.json") {
      configurationChanged = true;
    } else if (path.extname(fileName).toLowerCase() === ".rsgl") {
      rsglChanges.add(fileName);
    }
  }

  if (configurationChanged) {
    callbacks.invalidateProjectConfiguration?.();
  }
  for (const fileName of rsglChanges) {
    callbacks.invalidatePath(fileName);
  }
  if (!configurationChanged && rsglChanges.size === 0) {
    return false;
  }
  callbacks.refresh?.();
  return true;
}

/** Builds filesystem-backed resource validation options for the given source file. */
export function workspaceValidationOptionsFor(
  sourceFileName: string,
  settings: RsglValidationSettings,
  validationCache?: RsglWorkspaceValidationCache
): RsglWorkspaceAnalysisOptions {
  return resolvedResourceAnalysisConfiguration(
    sourceFileName,
    settings,
    validationCache
  ).options;
}

/** Creates the compiler/resolver identity used by the shared analysis cache. */
export function resourceAnalysisConfigurationFor(
  sourceFileName: string,
  settings: RsglValidationSettings,
  validationCache?: RsglWorkspaceValidationCache,
  projectContext?: RsglResourceSnapshotRequest["projectContext"],
  nativePathMappings: readonly RsglResourceUriNativePathMapping[] = []
): RsglResourceAnalysisConfiguration & { options: RsglWorkspaceAnalysisOptions } {
  return resolvedResourceAnalysisConfiguration(
    sourceFileName,
    settings,
    validationCache,
    projectContext,
    nativePathMappings
  );
}

function resolvedResourceAnalysisConfiguration(
  sourceFileName: string,
  settings: RsglValidationSettings,
  validationCache?: RsglWorkspaceValidationCache,
  projectContext?: RsglResourceSnapshotRequest["projectContext"],
  nativePathMappings: readonly RsglResourceUriNativePathMapping[] = []
): RsglResourceAnalysisConfiguration & { options: RsglWorkspaceAnalysisOptions } {
  const projectConfig = loadRsglProjectConfigForSource(sourceFileName)?.config;
  const sharedSettings = validationSettingsForSource(sourceFileName, settings);
  const projectDefaultAssetsPath = projectConfig?.defaultAssetsPath;
  const outputPackRoot = projectContext
    ? fileNameFromSerializedResourceUri(projectContext.outputPackRootUri, nativePathMappings)
    : resolveRsglOutputPackRoot(sourceFileName, projectConfig?.outDir);
  const defaultAssetsPath = projectContext
    ? directoryLayerFileName(projectContext.vanillaLayer, nativePathMappings)
    : projectDefaultAssetsPath === undefined
      ? sharedSettings.defaultAssetsPath
      : projectDefaultAssetsPath;
  const resourcePackRoots = projectContext
    ? projectContext.externalLayers.flatMap(layer =>
        directoryLayerFileName(layer, nativePathMappings) ?? [])
    : projectConfig?.resourcePackRoots ?? sharedSettings.resourcePackRoots;
  const unavailableResolutionScopes = projectContext
    ? [
        ...(!outputPackRoot ? ["local" as const] : []),
        ...(projectContext.externalLayers.some(layer =>
          !directoryLayerFileName(layer, nativePathMappings))
          ? ["custom" as const]
          : []),
        ...(projectContext.vanillaLayer
          && !directoryLayerFileName(projectContext.vanillaLayer, nativePathMappings)
          ? ["vanilla" as const]
          : [])
      ]
    : [];
  const compileOptions: RsglWorkspaceAnalysisOptions = {
    ...compileOptionsFromProjectConfig(projectConfig ?? {}, {
      sourceFileName,
      outputPackRoot,
      defaultAssetsPath,
      resourcePackRoots,
      cache: validationCache
    }),
    ...(settings.stdlibRoot ? { stdlibRoot: settings.stdlibRoot } : {}),
    ...(projectContext?.targetPackFormat
      ? { targetPackFormat: projectContext.targetPackFormat }
      : {})
  };
  return {
    cacheKey: JSON.stringify({
      semantic: resolveRsglCompileConfiguration(compileOptions).semanticFingerprint,
      stdlibRoot: normalizedOptionalPath(settings.stdlibRoot),
      outputPackRoot: normalizedOptionalPath(outputPackRoot),
      defaultAssetsPath: normalizedOptionalPath(defaultAssetsPath),
      resourcePackRoots: resourcePackRoots.map(root => normalizePathKey(path.resolve(root))),
      globalExterns: projectConfig?.extern ?? [],
      checkExternExistence: projectConfig?.checkExternExistence,
      unavailableResolutionScopes,
      validationGeneration: validationCache?.generation ?? 0
    }),
    options: compileOptions,
    ...(unavailableResolutionScopes.length > 0 ? { unavailableResolutionScopes } : {})
  };
}

function directoryLayerFileName(
  layer: RsglResourceSnapshotRequest["projectContext"]["vanillaLayer"]
    | RsglResourceSnapshotRequest["projectContext"]["externalLayers"][number]
    | undefined,
  nativePathMappings: readonly RsglResourceUriNativePathMapping[]
): string | null {
  return layer?.source === "directory"
    ? fileNameFromSerializedResourceUri(layer.rootUri, nativePathMappings)
    : null;
}

function normalizedOptionalPath(fileName: string | null | undefined): string | null {
  return fileName ? normalizePathKey(path.resolve(fileName)) : null;
}

/** Returns the stable semantic identity of the nearest validated project config. */
export function projectSemanticConfigurationFingerprint(sourceFileName: string): string {
  const projectConfig = loadRsglProjectConfigForSource(sourceFileName)?.config;
  return resolveRsglCompileConfiguration(
    projectCompileOptionsFromRsglConfig(projectConfig ?? {})
  ).semanticFingerprint;
}

function validationSettingsForSource(
  sourceFileName: string,
  settings: RsglValidationSettings
): Pick<RsglValidationSettings, "defaultAssetsPath" | "resourcePackRoots"> {
  const scoped = workspaceFolderSettingsForSource(sourceFileName, settings);
  return scoped ?? settings;
}

/** Resolves normalized formatting settings for the longest owning workspace folder. */
export function formattingConfigurationForSource(
  sourceFileName: string,
  settings: RsglValidationSettings
): RsglFormattingConfiguration {
  const scoped = workspaceFolderSettingsForSource(sourceFileName, settings);
  return normalizeRsglFormattingConfiguration(scoped?.formatting ?? settings.formatting);
}

function workspaceFolderSettingsForSource(
  sourceFileName: string,
  settings: RsglValidationSettings
): RsglWorkspaceFolderValidationSettings | undefined {
  const source = path.resolve(sourceFileName);
  return [...(settings.workspaceFolders ?? [])]
    .filter(folder => isRsglPathInsideOrEqual(source, folder.workspaceFolderPath))
    .sort((left, right) => path.resolve(right.workspaceFolderPath).length
      - path.resolve(left.workspaceFolderPath).length)[0];
}

/** Resolves a document URI to a filesystem path, passing through non-file URIs. */
export function fileNameFromUri(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}

/** Resolves the explicit filesystem boundaries advertised by an LSP client. */
export function workspaceRootFileNamesFromInitialization(
  params: RsglWorkspaceInitializationParams
): string[] {
  const workspaceFolders = uniqueResolvedFileNames(
    (params.workspaceFolders ?? []).flatMap(folder => fileNameFromWorkspaceUri(folder.uri) ?? [])
  );
  if (workspaceFolders.length > 0) {
    return workspaceFolders;
  }

  const rootUriFileName = params.rootUri ? fileNameFromWorkspaceUri(params.rootUri) : null;
  if (rootUriFileName) {
    return [rootUriFileName];
  }
  return params.rootPath ? [path.resolve(params.rootPath)] : [];
}

/** Normalizes a filesystem path for identity comparisons. */
export function normalizeDisplayFileName(fileName: string): string {
  return path.normalize(fileName);
}

function fileNameFromWorkspaceUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? path.resolve(fileURLToPath(parsed)) : null;
  } catch {
    return null;
  }
}

function uniqueResolvedFileNames(fileNames: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const fileName of fileNames) {
    const resolved = path.resolve(fileName);
    const key = normalizePathKey(resolved);
    if (!unique.has(key)) {
      unique.set(key, resolved);
    }
  }
  return [...unique.values()];
}
