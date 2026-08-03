import * as path from "node:path";
import { citResourceTypeFor, getCitAssetCandidates } from "../../cit/citAssetResolver";
import { isCitModelFileName, isCitPropertiesFileName } from "../../cit/citPaths";
import {
  getAssetsResource,
  getResourceFileCandidates as getSharedResourceFileCandidates,
  parseResourceLocation,
  resolveResourceFile,
  stripPathExtension,
  type ResourceFileRequest
} from "../../../packages/mc-assets/src";
import { modelSourceForFile } from "../../services/modelParentChain";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem } from "../model/ModelDocument";
import { collectPotentialPackMetadataFileNames } from "./PackMetadataDependencies";

export interface ResolvedResourceFile {
  fileName: string;
  resourceId: string;
}

export class ResourceDependencyResolver {
  private readonly resolvedFiles = new Map<string, ResolvedResourceFile | null>();
  private readonly candidateFiles = new Map<string, string[]>();

  constructor(
    private readonly fileSystem: ModelPreviewFileSystem,
    private readonly configuration: ModelPreviewConfiguration,
    private readonly observeDependency?: (fileName: string) => void,
    /**
     * Shared workspace resolution used for non-CIT lookups. CIT-sourced
     * references keep the preview-local candidate path because the shared
     * resolver has no CIT candidate semantics.
     */
    private readonly resolveSharedResourcePath?: (request: ResourceFileRequest) => string | null
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
    candidates.forEach(candidate => this.observeDependency?.(candidate));
    const request = createResourceFileRequest(
      resourcePath,
      sourceFileName,
      target,
      source,
      extension,
      this.configuration
    );
    const fileName = this.canUseSharedResolution(sourceFileName, target, extension)
      ? this.resolveSharedResourcePath!(request)
      : resolveResourceFile(
        request,
        { pathExists: candidate => this.fileSystem.fileExists(candidate) },
        candidates
      ).fileName;
    if (fileName) {
      const resolved = {
        fileName,
        resourceId: resourceIdForResolvedCandidate(resourcePath, fileName, target, extension)
      };
      this.resolvedFiles.set(key, resolved);
      return resolved;
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

    collectPotentialPackMetadataFileNames(sourceFileName, this.configuration)
      .forEach(candidate => this.observeDependency?.(candidate));
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
  private canUseSharedResolution(sourceFileName: string, target: string, extension: string | null): boolean {
    if (!this.resolveSharedResourcePath) {
      return false;
    }

    const citResourceType = citResourceTypeFor(target, extension);
    return !citResourceType || (!isCitModelFileName(sourceFileName) && !isCitPropertiesFileName(sourceFileName));
  }
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
  const citResourceType = citResourceTypeFor(target, extension);
  if (citResourceType && (isCitModelFileName(sourceFileName) || isCitPropertiesFileName(sourceFileName))) {
    return getCitAssetCandidates(sourceFileName, resourcePath, citResourceType, {
      pathExists: fileName => fileSystem.fileExists(fileName),
      getPackRoot: fileSystem.getPackRoot ? fileName => fileSystem.getPackRoot?.(fileName) ?? null : undefined
    });
  }

  return getSharedResourceFileCandidates(
    createResourceFileRequest(resourcePath, sourceFileName, target, source, extension, configuration),
    {
      pathExists: fileName => fileSystem.fileExists(fileName),
      getPackRoot: fileSystem.getPackRoot ? fileName => fileSystem.getPackRoot?.(fileName) ?? null : undefined,
      getPackMetadata: fileSystem.getPackMetadata
        ? packRoot => fileSystem.getPackMetadata?.(packRoot) ?? { overlays: [], filters: [] }
        : undefined
    }
  );
}

function createResourceFileRequest(
  resourcePath: string,
  sourceFileName: string,
  target: string,
  source: string,
  extension: string | null,
  configuration: ModelPreviewConfiguration
): ResourceFileRequest {
  return {
    resourcePath,
    sourceFileName,
    target,
    source,
    targetFileExtension: extension,
    defaultAssetsPath: configuration.defaultAssetsPath,
    resourcePackRoots: configuration.resourcePackRoots
  };
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

function resourceIdForResolvedCandidate(
  resourcePath: string,
  candidate: string,
  target: string,
  extension: string | null
): string {
  const location = parseResourceLocation(resourcePath, extension);
  if (location.isValid && target !== "models" && target !== "textures") {
    return `${location.namespace}:${stripPathExtension(location.resourcePath.replaceAll(path.sep, "/"))}`;
  }

  if (target === "models" || target === "textures") {
    return resourceIdFromFileName(candidate);
  }

  return path.basename(candidate, path.extname(candidate));
}

export function modelResourceIdFromFileName(fileName: string): string {
  const assetResource = getAssetsResource(fileName);
  if (!assetResource || !assetResource.resourcePath.startsWith("models/")) {
    return path.basename(fileName, path.extname(fileName));
  }

  return `${assetResource.namespace}:${stripPathExtension(assetResource.resourcePath.slice("models/".length))}`;
}

function resourceIdFromFileName(fileName: string): string {
  const assetResource = getAssetsResource(fileName);
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
  return `${assetResource.namespace}:${stripPathExtension(rawPath)}`;
}
