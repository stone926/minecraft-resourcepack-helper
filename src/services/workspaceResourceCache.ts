import type { Dirent } from "node:fs";
import type { SoundEventFileGraph } from "../diagnostics/soundEventGraph";
import type {
  OggMetadata,
  PackMetadata,
  PngMetadata,
  ResourceFileRequest,
  ResourceLocation
} from "../../packages/mc-assets/src";
import type { JsonDocumentNode } from "../utils/jsonAst";
import type { ResourceReference } from "../utils/resourceReferences/types";
import type { ResourceReferenceCacheDescriptor } from "../utils/resourceReferences/host";
import { FileSystemResourceCache, type OpenTextDocumentProvider } from "./fileSystemResourceCache";
import type { FileFreshnessPolicyOptions, WatcherTrustProvider } from "./fileFreshnessPolicy";
import { MediaMetadataCache } from "./mediaMetadataCache";
import { ModelPreviewArtifactCache } from "./modelPreviewArtifactCache";
import { ModelResourceCache } from "./modelResourceCache";
import type {
  CachedModelParentChain,
  CachedModelDocument,
  CachedTextureVariableDefinition
} from "./modelParentChain";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import type {
  CacheStatsSnapshot,
  CacheTextDocument,
  ResourceCacheGenerationState,
  ResourceConfiguration
} from "./resourceCacheTypes";
import { ResourceResolutionCache } from "./resourceResolutionCache";
import { ResourceMutationTracker } from "./resourceMutationTracker";
import { ResourceReferenceCache } from "./resourceReferenceCache";
import { openDocumentFileVersion } from "./resourceCacheTypes";

/**
 * Coordination facade for workspace resource caches.
 *
 * Storage and invalidation details live in focused cache components; consumers
 * keep one stable host while configuration and filesystem generations are
 * coordinated here.
 */
export class WorkspaceResourceCache implements ResourceCacheGenerationState {
  private configurationVersion = 0;
  private resourceFsGeneration = 0;
  private readonly resourceMutations = new ResourceMutationTracker();
  private readonly metrics = new ResourceCacheMetrics();
  private readonly fileSystem: FileSystemResourceCache;
  private readonly resourceResolution: ResourceResolutionCache;
  private readonly models: ModelResourceCache;
  private readonly mediaMetadata: MediaMetadataCache;
  private readonly references: ResourceReferenceCache;
  private readonly modelPreviewArtifacts: ModelPreviewArtifactCache;

  constructor(freshnessOptions: FileFreshnessPolicyOptions = {}) {
    this.fileSystem = new FileSystemResourceCache(this, this.metrics, freshnessOptions);
    this.resourceResolution = new ResourceResolutionCache({
      pathExists: fileName => this.fileSystem.getPathExists(fileName),
      getPackRoot: fileName => this.fileSystem.getPackRoot(fileName),
      getPackMetadata: packRoot => this.fileSystem.getPackMetadata(packRoot),
      canReuseVerifiedPaths: (fileNames, verifiedAt) =>
        this.fileSystem.canReuseVerifiedPaths(fileNames, verifiedAt),
      verificationTimestamp: () => this.fileSystem.verificationTimestamp()
    }, this, this.metrics);
    this.models = new ModelResourceCache({
      resolveResourcePathWithDependencies: request =>
        this.resourceResolution.resolveResourcePathWithDependencies(request),
      getJsonFileAst: fileName => this.fileSystem.getJsonFileAst(fileName),
      getJsonFileAstAsync: fileName => this.fileSystem.getJsonFileAstAsync(fileName),
      getFileVersion: fileName => this.fileSystem.getFileVersion(fileName),
      canReuseVerifiedPaths: (fileNames, verifiedAt) =>
        this.fileSystem.canReuseVerifiedPaths(fileNames, verifiedAt),
      verificationTimestamp: () => this.fileSystem.verificationTimestamp()
    }, this, this.metrics);
    this.mediaMetadata = new MediaMetadataCache({
      getFileVersion: fileName => this.fileSystem.getFileVersion(fileName)
    }, this, this.metrics);
    this.references = new ResourceReferenceCache(this.metrics);
    this.modelPreviewArtifacts = new ModelPreviewArtifactCache(this.models, this.mediaMetadata);
  }

  setOpenTextDocumentProvider(provider: OpenTextDocumentProvider | null): void {
    this.fileSystem.setOpenTextDocumentProvider(provider);
  }

  setWatcherTrustProvider(provider: WatcherTrustProvider | null): void {
    this.fileSystem.setWatcherTrustProvider(provider);
  }

  getConfigurationVersion(): number {
    return this.configurationVersion;
  }

  getResourceFsGeneration(): number {
    return this.resourceFsGeneration;
  }

  /**
   * Monotonic generation for any resource state mutation, including unsaved
   * document edits. Async consumers use it to reject results assembled across
   * two different filesystem snapshots.
   */
  getResourceMutationGeneration(): number {
    return this.resourceMutations.currentGeneration();
  }

  hasAnyResourceChangedSince(generation: number, fileNames: Iterable<string>): boolean {
    return this.resourceMutations.hasAnyChangedSince(generation, fileNames);
  }

  getPathExists(fileName: string): boolean {
    return this.fileSystem.getPathExists(fileName);
  }

  getDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    return this.fileSystem.getDirectoryEntries(directory);
  }

  getDirectoryEntriesSync(directory: string): Dirent[] | null {
    return this.fileSystem.getDirectoryEntriesSync(directory);
  }

  getJsonAst(document: CacheTextDocument): JsonDocumentNode | null {
    return this.fileSystem.getJsonAst(document);
  }

  getJsonFileAst(fileName: string): JsonDocumentNode | null {
    return this.fileSystem.getJsonFileAst(fileName);
  }

  getJsonFileAstAsync(fileName: string): Promise<JsonDocumentNode | null> {
    return this.fileSystem.getJsonFileAstAsync(fileName);
  }

  getFileVersion(fileName: string): string | null {
    return this.fileSystem.getFileVersion(fileName);
  }

  getResourceReferenceDocumentVersion(document: CacheTextDocument): string | null {
    if (typeof document.version === "number") {
      return openDocumentFileVersion(document.version);
    }
    const fileVersion = this.fileSystem.getFileVersion(document.fileName);
    return fileVersion ? `file:${fileVersion}` : null;
  }

  getCachedResourceReferences(
    descriptor: ResourceReferenceCacheDescriptor
  ): ResourceReference[] | null {
    return this.references.get(descriptor);
  }

  setCachedResourceReferences(
    descriptor: ResourceReferenceCacheDescriptor,
    references: ResourceReference[]
  ): void {
    this.references.set(descriptor, references);
  }

  getPackRoot(fileName: string): string | null {
    return this.fileSystem.getPackRoot(fileName);
  }

  getPackRootWithin(fileName: string, workspaceRoot: string): string | null {
    return this.fileSystem.getPackRootWithin(fileName, workspaceRoot);
  }

  getPackMetadata(packRoot: string): PackMetadata {
    return this.fileSystem.getPackMetadata(packRoot);
  }

  getResourceRootCandidates(
    request: ResourceFileRequest,
    resourcePath: string,
    namespace: string
  ): string[] {
    return this.resourceResolution.getResourceRootCandidates(request, resourcePath, namespace);
  }

  resolveResourcePath(request: ResourceFileRequest): string | null {
    return this.resourceResolution.resolveResourcePath(request);
  }

  getResourceLocation(resourcePath: string, targetFileExtension: string | null): ResourceLocation {
    return this.resourceResolution.getResourceLocation(resourcePath, targetFileExtension);
  }

  getSoundEventGraphAsync(soundsJsonPath: string): Promise<SoundEventFileGraph | null> {
    return this.fileSystem.getSoundEventGraphAsync(soundsJsonPath);
  }

  getPngMetadata(fileName: string): PngMetadata | null {
    return this.mediaMetadata.getPngMetadata(fileName);
  }

  getOggMetadata(fileName: string): OggMetadata | null {
    return this.mediaMetadata.getOggMetadata(fileName);
  }

  getModelPreviewArtifactCache(): ModelPreviewArtifactCache {
    return this.modelPreviewArtifacts;
  }

  getModelParentChain(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): CachedModelDocument[] {
    return this.models.getModelParentChain(document, ast, configuration, source);
  }

  getModelParentChainAsync(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): Promise<CachedModelDocument[]> {
    return this.models.getModelParentChainAsync(document, ast, configuration, source);
  }

  getModelParentChainResultAsync(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): Promise<CachedModelParentChain> {
    return this.models.getModelParentChainResultAsync(document, ast, configuration, source);
  }

  getModelTextureVariableDefinitions(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): ReadonlyMap<string, CachedTextureVariableDefinition> {
    return this.models.getModelTextureVariableDefinitions(document, ast, configuration, source);
  }

  invalidateAll(): void {
    this.resourceMutations.recordGlobal();
    this.resourceFsGeneration++;
    this.fileSystem.invalidateAll();
    this.resourceResolution.invalidateAll();
    this.models.invalidateAll();
    this.mediaMetadata.invalidateAll();
    this.references.invalidateAll();
  }

  invalidatePath(fileName: string): void {
    this.resourceMutations.recordPath(fileName);
    this.fileSystem.invalidatePath(fileName);
    this.resourceResolution.invalidatePath(fileName);
    this.models.invalidatePath(fileName);
    this.mediaMetadata.invalidatePath(fileName);
    this.references.invalidatePath(fileName);
  }

  invalidateDocument(document: CacheTextDocument): void {
    this.resourceMutations.recordPath(document.fileName);
    this.fileSystem.invalidateDocument(document);
    this.resourceResolution.invalidateDocument(document.fileName);
    this.models.invalidatePath(document.fileName);
    this.mediaMetadata.invalidateDocument(document.fileName);
    this.references.invalidatePath(document.fileName);
  }

  invalidateConfiguration(): void {
    this.resourceMutations.recordGlobal();
    this.configurationVersion++;
    this.fileSystem.invalidateConfiguration();
    this.resourceResolution.invalidateConfiguration();
    this.models.invalidateConfiguration();
  }

  getStats(): CacheStatsSnapshot {
    const metrics = this.metrics.snapshot();
    return {
      configurationVersion: this.configurationVersion,
      resourceFsGeneration: this.resourceFsGeneration,
      sizes: {
        ...this.fileSystem.getSizes(),
        ...this.resourceResolution.getSizes(),
        ...this.models.getSizes(),
        ...this.mediaMetadata.getSizes(),
        resourceReferences: this.references.size
      },
      hits: metrics.hits,
      misses: metrics.misses
    };
  }
}

export const workspaceResourceCache = new WorkspaceResourceCache();
