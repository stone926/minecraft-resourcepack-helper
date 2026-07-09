import * as path from "node:path";
import { getCitPathCandidates, isCitModelFileName, isCitPropertiesFileName, type CitResourceType } from "../../cit/citPaths";
import { getDocumentResourceRootCandidates, packRootFromAssetsPath, parseAssetsPath, parseResourceLocation } from "../../../packages/mc-assets/src";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem } from "../model/ModelDocument";

export interface ResolvedResourceFile {
  fileName: string;
  resourceId: string;
}

export function resolveModelFileName(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  return resolveResourceFileName(resourcePath, sourceFileName, "models", modelSourceForFile(sourceFileName), "json", fileSystem, configuration);
}

export function resolveTextureFileName(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  return resolveResourceFileName(resourcePath, sourceFileName, "textures", modelSourceForFile(sourceFileName), "png", fileSystem, configuration);
}

export function getModelFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): string[] {
  return getResourceFileCandidates(resourcePath, sourceFileName, "models", modelSourceForFile(sourceFileName), "json", fileSystem, configuration);
}

export function getTextureFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): string[] {
  return getResourceFileCandidates(resourcePath, sourceFileName, "textures", modelSourceForFile(sourceFileName), "png", fileSystem, configuration);
}

export function resolveResourceFileName(
  resourcePath: string,
  sourceFileName: string,
  target: string,
  source: string,
  extension: string | null,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  const candidates = getResourceFileCandidates(resourcePath, sourceFileName, target, source, extension, fileSystem, configuration);
  for (const candidate of candidates) {
    if (fileSystem.fileExists(candidate)) {
      return {
        fileName: candidate,
        resourceId: resourceIdForResolvedCandidate(resourcePath, candidate, target, extension)
      };
    }
  }

  return null;
}

export function getResourceFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  target: string,
  source: string,
  extension: string | null,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): string[] {
  const citResourceType = getCitResourceType(target, extension);
  if (citResourceType && (isCitModelFileName(sourceFileName) || isCitPropertiesFileName(sourceFileName))) {
    return getCitResourceFileCandidates(resourcePath, sourceFileName, citResourceType, fileSystem);
  }

  const location = parseResourceLocation(resourcePath, extension);
  if (!location.isValid) {
    return [];
  }

  const candidateRoots = getDocumentResourceRootCandidates(
    sourceFileName,
    source,
    configuration.defaultAssetsPath,
    location.namespace,
    target,
    {
      pathExists: fileName => fileSystem.fileExists(fileName),
      getPackRoot: fileSystem.getPackRoot ? fileName => fileSystem.getPackRoot?.(fileName) ?? null : undefined,
      getPackMetadata: fileSystem.getPackMetadata ? packRoot => fileSystem.getPackMetadata?.(packRoot) ?? { overlays: [], filters: [] } : undefined,
      resourcePackRoots: configuration.resourcePackRoots,
      resourcePath: path.posix.join(target.replaceAll("\\", "/"), location.resourcePath.replaceAll(path.sep, "/"))
    }
  );

  return unique(candidateRoots.map(root => path.join(root, location.resourcePath)));
}

function getCitResourceFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  resourceType: CitResourceType,
  fileSystem: ModelPreviewFileSystem
): string[] {
  const packRoot = fileSystem.getPackRoot?.(sourceFileName) ?? packRootFromAssetsPath(sourceFileName);
  return packRoot ? getCitPathCandidates(sourceFileName, packRoot, resourcePath, resourceType) : [];
}

function resourceIdForResolvedCandidate(
  resourcePath: string,
  candidate: string,
  target: string,
  extension: string | null
): string {
  const location = parseResourceLocation(resourcePath, extension);
  if (location.isValid && target !== "models" && target !== "textures") {
    return `${location.namespace}:${stripExtension(location.resourcePath.replaceAll(path.sep, "/"))}`;
  }

  if (target === "models" || target === "textures") {
    return resourceIdFromFileName(candidate);
  }

  return path.basename(candidate, path.extname(candidate));
}

export function modelResourceIdFromFileName(fileName: string): string {
  const assetResource = getAssetResource(fileName);
  if (!assetResource || !assetResource.resourcePath.startsWith("models/")) {
    return path.basename(fileName, path.extname(fileName));
  }

  return `${assetResource.namespace}:${stripExtension(assetResource.resourcePath.slice("models/".length))}`;
}

export function modelSourceForFile(fileName: string): string {
  if (/[\\/]models[\\/]item[\\/]/i.test(fileName)) {
    return "models/item";
  }

  if (/[\\/]models[\\/]block[\\/]/i.test(fileName)) {
    return "models/block";
  }

  return "models";
}

function getAssetResource(fileName: string): { namespace: string; resourcePath: string } | null {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length === 0) {
    return null;
  }

  return {
    namespace: parsed.namespace,
    resourcePath: parsed.relativeSegments.join("/")
  };
}

function resourceIdFromFileName(fileName: string): string {
  const assetResource = getAssetResource(fileName);
  if (!assetResource) {
    return path.basename(fileName, path.extname(fileName));
  }

  const resourcePath = assetResource.resourcePath.replaceAll("\\", "/");
  const typedPrefix = resourcePath.startsWith("models/")
    ? "models/"
    : resourcePath.startsWith("textures/")
      ? "textures/"
      : "";
  const rawPath = typedPrefix ? resourcePath.slice(typedPrefix.length) : resourcePath;
  return `${assetResource.namespace}:${stripExtension(rawPath)}`;
}

function getCitResourceType(target: string, extension: string | null): CitResourceType | null {
  if (target === "models" && extension === "json") {
    return "models";
  }
  if (target === "textures" && extension === "png") {
    return "textures";
  }
  return null;
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
