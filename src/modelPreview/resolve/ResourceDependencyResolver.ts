import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getCitPathCandidates, isCitModelFileName, isCitPropertiesFileName, type CitResourceType } from "../../utils/citPaths";
import { getDocumentResourceRootCandidates, parseResourceLocation } from "../../../packages/mc-assets/src";
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

export function resolveResourceFileName(
  resourcePath: string,
  sourceFileName: string,
  target: string,
  source: string,
  extension: string | null,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  const citResourceType = getCitResourceType(target, extension);
  if (citResourceType && (isCitModelFileName(sourceFileName) || isCitPropertiesFileName(sourceFileName))) {
    return resolveCitResourceFileName(resourcePath, sourceFileName, citResourceType, fileSystem);
  }

  const location = parseResourceLocation(resourcePath, extension);
  if (!location.isValid) {
    return null;
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

  for (const root of candidateRoots) {
    const candidate = path.join(root, location.resourcePath);
    if (fileSystem.fileExists(candidate)) {
      return {
        fileName: candidate,
        resourceId: `${location.namespace}:${stripExtension(location.resourcePath.replaceAll(path.sep, "/"))}`
      };
    }
  }

  return null;
}

function resolveCitResourceFileName(
  resourcePath: string,
  sourceFileName: string,
  resourceType: CitResourceType,
  fileSystem: ModelPreviewFileSystem
): ResolvedResourceFile | null {
  const packRoot = fileSystem.getPackRoot?.(sourceFileName) ?? getPackRootFromAssetsPath(sourceFileName);
  if (!packRoot) {
    return null;
  }

  for (const candidate of getCitPathCandidates(sourceFileName, packRoot, resourcePath, resourceType)) {
    if (fileSystem.fileExists(candidate)) {
      return {
        fileName: candidate,
        resourceId: resourceIdFromFileName(candidate)
      };
    }
  }

  return null;
}

export function modelResourceIdFromFileName(fileName: string): string {
  const assetResource = getAssetResource(fileName);
  if (!assetResource || !assetResource.resourcePath.startsWith("models/")) {
    return path.basename(fileName, path.extname(fileName));
  }

  return `${assetResource.namespace}:${stripExtension(assetResource.resourcePath.slice("models/".length))}`;
}

export function fileUriString(fileName: string): string {
  return pathToFileURL(path.resolve(fileName)).href;
}

export function fileNameKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
  const normalized = path.normalize(fileName);
  const segments = normalized.split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");

  if (assetsIndex < 0 || segments.length <= assetsIndex + 2) {
    return null;
  }

  return {
    namespace: segments[assetsIndex + 1],
    resourcePath: segments.slice(assetsIndex + 2).join("/")
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

function getPackRootFromAssetsPath(fileName: string): string | null {
  const normalizedPath = path.normalize(fileName);
  const parsedPath = path.parse(normalizedPath);
  const segments = path.relative(parsedPath.root, normalizedPath).split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0) {
    return null;
  }

  return path.join(parsedPath.root, ...segments.slice(0, assetsIndex));
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}
