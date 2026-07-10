import type { Dirent } from "node:fs";
import type {
  OggMetadata,
  PackMetadata,
  PngMetadata,
  ResourceLocation
} from "../../packages/mc-assets/src";
import type { JsonDocumentNode } from "../utils/jsonAst";
import { FileSystemResourceCache, type OpenTextDocumentProvider } from "./fileSystemResourceCache";
import { MediaMetadataCache } from "./mediaMetadataCache";
import { ModelPreviewArtifactCache } from "./modelPreviewArtifactCache";
import { ModelResourceCache } from "./modelResourceCache";
import type {
  CachedModelDocument,
  CachedTextureVariableDefinition
} from "./modelParentChain";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import type {
  CacheStatsSnapshot,
  CacheTextDocument,
  ResourceCacheGenerationState,
  ResourceConfiguration,
  ResourceResolveRequest
} from "./resourceCacheTypes";
import { ResourceResolutionCache } from "./resourceResolutionCache";

export type {
  CacheStatsSnapshot,
  CacheTextDocument,
  ResourceConfiguration,
  ResourceResolveRequest
} from "./resourceCacheTypes";
export type { CachedModelDocument, CachedTextureVariableDefinition } from "./modelParentChain";

/**
 * Compatibility facade for workspace resource caches.
 *
 * Storage and invalidation details live in focused cache components; consumers
 * keep one stable host while configuration and filesystem generations are
 * coordinated here.
 */
export class WorkspaceResourceCache implements ResourceCacheGenerationState {
  private configurationVersion = 0;
  private resourceFsGeneration = 0;
  private resourceIndexGeneration = 0;
  private readonly metrics = new ResourceCacheMetrics();
  private readonly fileSystem: FileSystemResourceCache;
  private readonly resourceResolution: ResourceResolutionCache;
  private readonly models: ModelResourceCache;
  private readonly mediaMetadata: MediaMetadataCache;
  readonly modelPreviewArtifacts: ModelPreviewArtifactCache;

  constructor() {
    this.fileSystem = new FileSystemResourceCache(this, this.metrics);
    this.resourceResolution = new ResourceResolutionCache({
      pathExists: fileName => this.fileSystem.getPathExists(fileName),
      getPackRoot: fileName => this.fileSystem.getPackRoot(fileName),
      getPackMetadata: packRoot => this.fileSystem.getPackMetadata(packRoot)
    }, this, this.metrics);
    this.models = new ModelResourceCache({
      resolveResourcePath: request => this.resourceResolution.resolveResourcePath(request),
      getJsonFileAst: fileName => this.fileSystem.getJsonFileAst(fileName),
      getFileVersion: fileName => this.fileSystem.getFileVersion(fileName)
    }, this, this.metrics);
    this.mediaMetadata = new MediaMetadataCache({
      getFileVersion: fileName => this.fileSystem.getFileVersion(fileName)
    }, this, this.metrics);
    this.modelPreviewArtifacts = new ModelPreviewArtifactCache(this.models, this.mediaMetadata);
  }

  setOpenTextDocumentProvider(provider: OpenTextDocumentProvider | null): void {
    this.fileSystem.setOpenTextDocumentProvider(provider);
  }

  getConfigurationVersion(): number {
    return this.configurationVersion;
  }

  getResourceFsGeneration(): number {
    return this.resourceFsGeneration;
  }

  getResourceIndexGeneration(): number {
    return this.resourceIndexGeneration;
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

  getFileVersion(fileName: string): string | null {
    return this.fileSystem.getFileVersion(fileName);
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
    request: ResourceResolveRequest,
    resourcePath: string,
    namespace: string
  ): string[] {
    return this.resourceResolution.getResourceRootCandidates(request, resourcePath, namespace);
  }

  resolveResourcePath(request: ResourceResolveRequest): string | null {
    return this.resourceResolution.resolveResourcePath(request);
  }

  getResourceLocation(resourcePath: string, targetFileExtension: string | null): ResourceLocation {
    return this.resourceResolution.getResourceLocation(resourcePath, targetFileExtension);
  }

  getSoundEvents(soundsJsonPath: string): Set<string> | null {
    return this.fileSystem.getSoundEvents(soundsJsonPath);
  }

  getPngMetadata(fileName: string): PngMetadata | null {
    return this.mediaMetadata.getPngMetadata(fileName);
  }

  getOggMetadata(fileName: string): OggMetadata | null {
    return this.mediaMetadata.getOggMetadata(fileName);
  }

  getModelParentChain(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source?: string
  ): CachedModelDocument[] {
    return this.models.getModelParentChain(document, ast, configuration, source);
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
    this.resourceFsGeneration++;
    this.resourceIndexGeneration++;
    this.fileSystem.invalidateAll();
    this.resourceResolution.invalidateAll();
    this.models.invalidateAll();
    this.mediaMetadata.invalidateAll();
  }

  invalidatePath(fileName: string): void {
    this.resourceIndexGeneration++;
    this.fileSystem.invalidatePath(fileName);
    this.resourceResolution.invalidatePath(fileName);
    this.models.invalidatePath(fileName);
    this.mediaMetadata.invalidatePath(fileName);
  }

  invalidateDocument(document: CacheTextDocument): void {
    this.fileSystem.invalidateDocument(document);
    this.resourceResolution.invalidateDocument(document.fileName);
    this.models.invalidatePath(document.fileName);
    this.mediaMetadata.invalidateDocument(document.fileName);
  }

  invalidateConfiguration(): void {
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
        ...this.mediaMetadata.getSizes()
      },
      hits: metrics.hits,
      misses: metrics.misses
    };
  }
}

export const workspaceResourceCache = new WorkspaceResourceCache();
