import * as path from "node:path";
import { citResourceTypeFor } from "../../cit/citAssetResolver";
import { isCitModelFileName, isCitPropertiesFileName } from "../../cit/citPaths";
import {
  getResourceFileCandidates as getSharedResourceFileCandidates,
  inferMinecraftResourceIdFromAssetsFile,
  parseResourceLocation,
  resolveResourceFile,
  stripPathExtension,
  type ResourceFileRequest
} from "../../../packages/mc-assets/src";
import { modelSourceForFile } from "../../services/modelParentChain";
import type { ModelPreviewConfiguration, ModelPreviewFileSystem } from "../model/ModelDocument";
import { observeCitAssetCandidates } from "./CitAssetCandidateObserver";
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

    const citResourceType = citResourceTypeFor(target, extension);
    const citSource = isCitModelFileName(sourceFileName) || isCitPropertiesFileName(sourceFileName);
    let candidates: string[];
    if (citResourceType && citSource) {
      candidates = observeCitAssetCandidates(sourceFileName, resourcePath, citResourceType, {
        fileSystem: this.fileSystem,
        configuration: this.configuration,
        observeDependency: this.observeDependency
      });
    } else {
      collectPotentialPackMetadataFileNames(sourceFileName, this.configuration)
        .forEach(candidate => this.observeDependency?.(candidate));
      candidates = getSharedResourceFileCandidates(
        createResourceFileRequest(
          resourcePath,
          sourceFileName,
          target,
          source,
          extension,
          this.configuration
        ),
        createResourceResolutionHost(this.fileSystem)
      );
      candidates.forEach(candidate => this.observeDependency?.(candidate));
    }
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

function createResourceResolutionHost(fileSystem: ModelPreviewFileSystem) {
  return {
    pathExists: (fileName: string) => fileSystem.fileExists(fileName),
    getPackRoot: fileSystem.getPackRoot
      ? (fileName: string) => fileSystem.getPackRoot?.(fileName) ?? null
      : undefined,
    getPackMetadata: fileSystem.getPackMetadata
      ? (packRoot: string) => fileSystem.getPackMetadata?.(packRoot) ?? { overlays: [], filters: [] }
      : undefined
  };
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
    return resourceIdFromFileName(candidate, ["models", "textures"]);
  }

  return path.basename(candidate, path.extname(candidate));
}

export function modelResourceIdFromFileName(fileName: string): string {
  return resourceIdFromFileName(fileName, ["models"], true);
}

function resourceIdFromFileName(
  fileName: string,
  stripPathPrefixes: readonly string[],
  requirePathPrefix = false
): string {
  return inferMinecraftResourceIdFromAssetsFile(fileName, {
    stripPathPrefixes,
    requirePathPrefix
  }) ?? path.basename(fileName, path.extname(fileName));
}
