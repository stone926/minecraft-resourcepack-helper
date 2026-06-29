import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocumentResourceRootCandidates, parseResourceLocation } from "../../utils/resourceLocation";
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
