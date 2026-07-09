import * as path from "node:path";
import { getCitPathCandidates, isCitModelFileName, isCitPropertiesFileName, type CitResourceType } from "../../cit/citPaths";
import { getDocumentResourceRootCandidates, packRootFromAssetsPath, parseAssetsPath, parseResourceLocation } from "../../../packages/mc-assets/src";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem } from "../model/ModelDocument";

export interface ResolvedResourceFile {
  fileName: string;
  resourceId: string;
}

export class ResourceDependencyResolver {
  private readonly resolvedFiles = new Map<string, ResolvedResourceFile | null>();
  private readonly candidateFiles = new Map<string, string[]>();

  constructor(
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly configuration: ModelPreviewConfiguration
  ) { }

  resolveModelFileName(resourcePath: string, sourceFileName: string): ResolvedResourceFile | null {
    return this.resolveResourceFileName(resourcePath, sourceFileName, "models", modelSourceForFile(sourceFileName), "json");
  }

  resolveTextureFileName(resourcePath: string, sourceFileName: string): ResolvedResourceFile | null {
    return this.resolveResourceFileName(resourcePath, sourceFileName, "textures", modelSourceForFile(sourceFileName), "png");
  }

  getModelFileCandidates(resourcePath: string, sourceFileName: string): string[] {
    return this.getResourceFileCandidates(resourcePath, sourceFileName, "models", modelSourceForFile(sourceFileName), "json");
  }

  getTextureFileCandidates(resourcePath: string, sourceFileName: string): string[] {
    return this.getResourceFileCandidates(resourcePath, sourceFileName, "textures", modelSourceForFile(sourceFileName), "png");
  }

  resolveResourceFileName(
    resourcePath: string,
    sourceFileName: string,
    target: string,
    source: string,
    extension: string | null
  ): ResolvedResourceFile | null {
    const key = resourceResolutionKey(resourcePath, sourceFileName, target, source, extension);
    if (this.resolvedFiles.has(key)) {
      return this.resolvedFiles.get(key) ?? null;
    }

    const candidates = this.getResourceFileCandidates(resourcePath, sourceFileName, target, source, extension);
    for (const candidate of candidates) {
      if (this.fileSystem.fileExists(candidate)) {
        const resolved = {
          fileName: candidate,
          resourceId: resourceIdForResolvedCandidate(resourcePath, candidate, target, extension)
        };
        this.resolvedFiles.set(key, resolved);
        return resolved;
      }
    }

    this.resolvedFiles.set(key, null);
    return null;
  }

  getResourceFileCandidates(
    resourcePath: string,
    sourceFileName: string,
    target: string,
    source: string,
    extension: string | null
  ): string[] {
    const key = resourceResolutionKey(resourcePath, sourceFileName, target, source, extension);
    const cached = this.candidateFiles.get(key);
    if (cached) {
      return cached;
    }

    const candidates = getResourceFileCandidatesUncached(
      resourcePath,
      sourceFileName,
      target,
      source,
      extension,
      this.fileSystem,
      this.configuration
    );
    this.candidateFiles.set(key, candidates);
    return candidates;
  }
}

export function resolveModelFileName(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  return new ResourceDependencyResolver(fileSystem, configuration).resolveModelFileName(resourcePath, sourceFileName);
}

export function resolveTextureFileName(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): ResolvedResourceFile | null {
  return new ResourceDependencyResolver(fileSystem, configuration).resolveTextureFileName(resourcePath, sourceFileName);
}

export function getModelFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): string[] {
  return new ResourceDependencyResolver(fileSystem, configuration).getModelFileCandidates(resourcePath, sourceFileName);
}

export function getTextureFileCandidates(
  resourcePath: string,
  sourceFileName: string,
  fileSystem: ModelPreviewFileSystem,
  configuration: ModelPreviewConfiguration
): string[] {
  return new ResourceDependencyResolver(fileSystem, configuration).getTextureFileCandidates(resourcePath, sourceFileName);
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
  const resolver = new ResourceDependencyResolver(fileSystem, configuration);
  return resolver.resolveResourceFileName(resourcePath, sourceFileName, target, source, extension);
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
  return new ResourceDependencyResolver(fileSystem, configuration).getResourceFileCandidates(resourcePath, sourceFileName, target, source, extension);
}

function getResourceFileCandidatesUncached(
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

function resourceResolutionKey(
  resourcePath: string,
  sourceFileName: string,
  target: string,
  source: string,
  extension: string | null
): string {
  return [
    sourceFileName,
    source,
    target,
    extension ?? "",
    resourcePath
  ].join("\0");
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
