import * as path from "node:path";
import {
  getDocumentResourceRootCandidates,
  normalizePathKey,
  parseResourceLocation,
  resolveResourceFile,
  uniqueValues,
  type PackMetadata,
  type ResourceFileRequest,
  type ResourceLocation
} from "../../packages/mc-assets/src";
import { DependencyIndex } from "./dependencyIndex";
import { LruCache } from "./lruCache";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import type {
  CacheEntry,
  ResourceCacheGenerationState
} from "./resourceCacheTypes";

export interface ResourceResolutionCacheHost {
  pathExists(fileName: string): boolean;
  getPackRoot(fileName: string): string | null;
  getPackMetadata(packRoot: string): PackMetadata;
}

export class ResourceResolutionCache {
  private readonly resourceLocationCache = new LruCache<string, ResourceLocation>(4096);
  private readonly resourceRootCandidatesCache = new LruCache<string, CacheEntry<string[]>>(
    4096,
    key => this.resourceRootCandidateDependencies.release(key)
  );
  private readonly resourceRootCandidateDependencies = new DependencyIndex();
  private readonly resourceResolutionCache = new LruCache<string, CacheEntry<string | null>>(
    8192,
    key => this.resourceResolutionDependencies.release(key)
  );
  private readonly resourceResolutionDependencies = new DependencyIndex();

  constructor(
    private readonly host: ResourceResolutionCacheHost,
    private readonly state: ResourceCacheGenerationState,
    private readonly metrics: ResourceCacheMetrics
  ) {}

  getResourceRootCandidates(request: ResourceFileRequest, resourcePath: string, namespace: string): string[] {
    const key = [
      normalizePathKey(request.sourceFileName),
      request.source,
      request.target,
      namespace,
      resourcePath,
      normalizeOptionalPath(request.defaultAssetsPath),
      (request.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|"),
      this.state.getConfigurationVersion()
    ].join("\0");
    const generation = this.state.getResourceFsGeneration();
    const cached = this.resourceRootCandidatesCache.get(key);
    if (cached && cached.generation === generation) {
      this.metrics.hit("resourceRootCandidates");
      return cached.value;
    }

    this.metrics.miss("resourceRootCandidates");
    const candidates = getDocumentResourceRootCandidates(
      request.sourceFileName,
      request.source,
      request.defaultAssetsPath,
      namespace,
      request.target,
      {
        pathExists: fileName => this.host.pathExists(fileName),
        getPackRoot: fileName => this.host.getPackRoot(fileName),
        getPackMetadata: packRoot => this.host.getPackMetadata(packRoot),
        resourcePackRoots: request.resourcePackRoots,
        resourcePath
      }
    );
    this.resourceRootCandidatesCache.set(key, { generation, value: candidates });
    this.resourceRootCandidateDependencies.register(key, this.getResourceRootDependencyFiles(request));
    return candidates;
  }

  resolveResourcePath(request: ResourceFileRequest): string | null {
    const location = this.getResourceLocation(request.resourcePath, request.targetFileExtension);
    if (!location.isValid) {
      return null;
    }

    const key = [
      normalizePathKey(request.sourceFileName),
      request.source,
      request.target,
      request.targetFileExtension ?? "",
      request.resourcePath,
      location.namespace,
      location.resourcePath,
      normalizeOptionalPath(request.defaultAssetsPath),
      (request.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|"),
      this.state.getConfigurationVersion()
    ].join("\0");
    const generation = this.state.getResourceFsGeneration();
    const cached = this.resourceResolutionCache.get(key);
    if (cached && cached.generation === generation) {
      this.metrics.hit("resourceResolution");
      return cached.value;
    }

    this.metrics.miss("resourceResolution");
    const resolution = resolveResourceFile(request, {
      pathExists: candidate => this.host.pathExists(candidate),
      getResourceLocation: (resourcePath, targetFileExtension) => this.getResourceLocation(resourcePath, targetFileExtension),
      getRootCandidates: (resourceRequest, resourcePath, namespace) =>
        this.getResourceRootCandidates(resourceRequest, resourcePath, namespace)
    });
    this.resourceResolutionCache.set(key, { generation, value: resolution.fileName });
    this.resourceResolutionDependencies.register(key, [
      ...this.getResourceRootDependencyFiles(request),
      ...resolution.candidates
    ]);
    return resolution.fileName;
  }

  getResourceLocation(resourcePath: string, targetFileExtension: string | null): ResourceLocation {
    const key = `${resourcePath}\0${targetFileExtension ?? ""}`;
    const cached = this.resourceLocationCache.get(key);
    if (cached) {
      this.metrics.hit("resourceLocation");
      return cached;
    }

    this.metrics.miss("resourceLocation");
    const location = parseResourceLocation(resourcePath, targetFileExtension);
    this.resourceLocationCache.set(key, location);
    return location;
  }

  invalidateAll(): void {
    this.resourceLocationCache.clear();
    this.resourceRootCandidatesCache.clear();
    this.resourceRootCandidateDependencies.clear();
    this.resourceResolutionCache.clear();
    this.resourceResolutionDependencies.clear();
  }

  invalidatePath(fileName: string): void {
    const key = normalizePathKey(fileName);
    this.deleteResourceRootCandidateDependenciesForPath(key);
    this.deleteResourceResolutionDependenciesForPath(key);
  }

  invalidateDocument(fileName: string): void {
    this.invalidatePath(fileName);
  }

  invalidateConfiguration(): void {
    this.resourceRootCandidatesCache.clear();
    this.resourceRootCandidateDependencies.clear();
    this.resourceResolutionCache.clear();
    this.resourceResolutionDependencies.clear();
  }

  getSizes(): Record<string, number> {
    return {
      resourceLocation: this.resourceLocationCache.size,
      resourceRootCandidates: this.resourceRootCandidatesCache.size,
      resourceResolution: this.resourceResolutionCache.size
    };
  }

  private deleteResourceResolutionDependenciesForPath(fileKey: string): void {
    for (const cacheKey of this.resourceResolutionDependencies.affectedCacheKeys(fileKey)) {
      this.resourceResolutionCache.delete(cacheKey);
      this.resourceResolutionDependencies.release(cacheKey);
    }
  }

  private deleteResourceRootCandidateDependenciesForPath(fileKey: string): void {
    for (const cacheKey of this.resourceRootCandidateDependencies.affectedCacheKeys(fileKey)) {
      this.resourceRootCandidatesCache.delete(cacheKey);
      this.resourceRootCandidateDependencies.release(cacheKey);
    }
  }

  private getResourceRootDependencyFiles(request: ResourceFileRequest): string[] {
    return uniqueValues([
      request.sourceFileName,
      ...getAncestorPackMetadataCandidates(request.sourceFileName),
      ...(request.resourcePackRoots ?? []).map(root => path.join(root, "pack.mcmeta"))
    ]);
  }
}

function normalizeOptionalPath(value: string | null | undefined): string {
  return value ? normalizePathKey(value) : "";
}

function getAncestorPackMetadataCandidates(fileName: string): string[] {
  let directory = path.dirname(path.normalize(fileName));
  const root = path.parse(directory).root;
  const candidates: string[] = [];

  while (true) {
    candidates.push(path.join(directory, "pack.mcmeta"));
    if (directory === root) {
      return candidates;
    }
    directory = path.dirname(directory);
  }
}
