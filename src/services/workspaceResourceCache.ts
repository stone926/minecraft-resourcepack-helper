import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  JsonDocumentNode,
  memberName,
  objectMembers,
  parseJsonAst
} from "../utils/jsonAst";
import {
  findPackRoot,
  getDocumentResourceRootCandidates,
  normalizePathKey,
  parsePackMetadata,
  parseResourceLocation,
  readOggFileMetadata,
  readPackMetadata,
  readPngFileMetadata,
  type OggMetadata,
  type PackMetadata,
  type PngMetadata,
  type ResourceLocation
} from "../../packages/mc-assets/src";
import { DependencyIndex } from "./dependencyIndex";
import { LruCache } from "./lruCache";
import {
  collectModelTextureVariableDefinitions,
  loadModelParentChain,
  modelSourceForFile,
  type CachedModelDocument,
  type CachedTextureVariableDefinition
} from "./modelParentChain";

export type { CachedModelDocument, CachedTextureVariableDefinition } from "./modelParentChain";

export interface CacheTextDocument {
  fileName: string;
  languageId?: string;
  version?: number;
  uri?: {
    fsPath?: string;
    scheme?: string;
    toString(): string;
  };
  getText(): string;
}

export interface ResourceResolveRequest {
  resourcePath: string;
  sourceFileName: string;
  target: string;
  source: string;
  targetFileExtension: string | null;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface ResourceConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface CacheStatsSnapshot {
  configurationVersion: number;
  resourceFsGeneration: number;
  sizes: Record<string, number>;
  hits: Record<string, number>;
  misses: Record<string, number>;
}

interface CacheEntry<T> {
  generation: number;
  value: T;
}

interface VersionedCacheEntry<T> {
  version: string;
  value: T;
}

interface DocumentAstCacheEntry {
  fileName: string;
  version: number | undefined;
  ast: JsonDocumentNode | null;
}

type OpenTextDocumentProvider = (fileName: string) => CacheTextDocument | null;

const emptyPackMetadata: PackMetadata = { overlays: [], filters: [] };

export class WorkspaceResourceCache {
  private configurationVersion = 0;
  private resourceFsGeneration = 0;
  private resourceIndexGeneration = 0;
  private openTextDocumentProvider: OpenTextDocumentProvider | null = null;
  private readonly pathExistsCache = new LruCache<string, CacheEntry<boolean>>(8192);
  private readonly directoryEntriesCache = new LruCache<string, Promise<CacheEntry<Dirent[] | null>>>(1024);
  private readonly directoryEntriesSyncCache = new LruCache<string, CacheEntry<Dirent[] | null>>(1024);
  private readonly documentAstCache = new LruCache<string, DocumentAstCacheEntry>(1024);
  private readonly fileAstCache = new LruCache<string, VersionedCacheEntry<JsonDocumentNode | null>>(1024);
  private readonly resourceLocationCache = new LruCache<string, ResourceLocation>(4096);
  private readonly packRootCache = new LruCache<string, CacheEntry<string | null>>(4096);
  private readonly packMetadataCache = new LruCache<string, VersionedCacheEntry<PackMetadata>>(256);
  private readonly resourceRootCandidatesCache = new LruCache<string, CacheEntry<string[]>>(4096);
  private readonly resourceResolutionCache = new LruCache<string, CacheEntry<string | null>>(
    8192,
    key => this.resourceResolutionDependencies.release(key)
  );
  private readonly resourceResolutionDependencies = new DependencyIndex();
  private readonly soundEventsCache = new LruCache<string, VersionedCacheEntry<Set<string> | null>>(512);
  private readonly oggMetadataCache = new LruCache<string, VersionedCacheEntry<OggMetadata | null>>(2048);
  private readonly pngMetadataCache = new LruCache<string, VersionedCacheEntry<PngMetadata | null>>(2048);
  private readonly modelParentChainCache = new LruCache<string, CacheEntry<CachedModelDocument[]>>(
    1024,
    key => this.modelCacheDependencies.release(`chain\0${key}`)
  );
  private readonly modelTextureDefinitionsCache = new LruCache<string, CacheEntry<ReadonlyMap<string, CachedTextureVariableDefinition>>>(
    1024,
    key => this.modelCacheDependencies.release(`definitions\0${key}`)
  );
  private readonly modelCacheDependencies = new DependencyIndex();
  private readonly hits = new Map<string, number>();
  private readonly misses = new Map<string, number>();

  setOpenTextDocumentProvider(provider: OpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
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
    return this.getGenerationalValue("pathExists", this.pathExistsCache, normalizePathKey(fileName), () => fs.existsSync(fileName));
  }

  getDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    const key = normalizePathKey(directory);
    const cached = this.directoryEntriesCache.get(key);
    if (cached) {
      this.hit("directoryEntries");
      return cached.then(entry => entry.generation === this.resourceFsGeneration ? entry.value : this.readDirectoryEntries(directory));
    }

    this.miss("directoryEntries");
    const value = this.readDirectoryEntries(directory);
    this.directoryEntriesCache.set(key, value.then(entries => ({ generation: this.resourceFsGeneration, value: entries })));
    return value;
  }

  getDirectoryEntriesSync(directory: string): Dirent[] | null {
    return this.getGenerationalValue("directoryEntriesSync", this.directoryEntriesSyncCache, normalizePathKey(directory), () => {
      try {
        return fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return null;
      }
    });
  }

  getJsonAst(document: CacheTextDocument): JsonDocumentNode | null {
    const key = documentKey(document);
    const cached = this.documentAstCache.get(key);
    if (cached && cached.fileName === document.fileName && cached.version === document.version) {
      this.hit("documentAst");
      return cached.ast;
    }

    this.miss("documentAst");
    const ast = parseJsonAst(document.getText());
    this.documentAstCache.set(key, {
      fileName: document.fileName,
      version: document.version,
      ast
    });
    return ast;
  }

  getJsonFileAst(fileName: string): JsonDocumentNode | null {
    const openDocument = this.findOpenTextDocument(fileName);
    if (openDocument) {
      return this.getJsonAst(openDocument);
    }

    return this.getVersionedFileValue("fileAst", this.fileAstCache, fileName, () => {
      try {
        return parseJsonAst(fs.readFileSync(fileName, "utf8"));
      } catch {
        return null;
      }
    });
  }

  getFileVersion(fileName: string): string | null {
    const openDocument = this.findOpenTextDocument(fileName);
    if (openDocument && typeof openDocument.version === "number") {
      return `open:${openDocument.version}`;
    }

    try {
      const stat = fs.statSync(fileName);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  getPackRoot(fileName: string): string | null {
    return this.getGenerationalValue("packRoot", this.packRootCache, normalizePathKey(fileName), () =>
      findPackRoot(fileName, { pathExists: candidate => this.getPathExists(candidate) }));
  }

  getPackRootWithin(fileName: string, workspaceRoot: string): string | null {
    const normalizedWorkspaceRoot = path.normalize(workspaceRoot);
    const key = `${normalizePathKey(fileName)}\0${normalizePathKey(normalizedWorkspaceRoot)}`;
    return this.getGenerationalValue("packRoot", this.packRootCache, key, () => findPackRoot(fileName, {
      pathExists: candidate => this.getPathExists(candidate),
      stopAt: normalizedWorkspaceRoot
    }));
  }

  getPackMetadata(packRoot: string): PackMetadata {
    const key = normalizePathKey(packRoot);
    const mcmetaPath = path.join(packRoot, "pack.mcmeta");
    const version = this.getFileVersion(mcmetaPath) ?? `missing:${this.resourceFsGeneration}`;
    const cached = this.packMetadataCache.get(key);
    if (cached && cached.version === version) {
      this.hit("packMetadata");
      return cached.value;
    }

    this.miss("packMetadata");
    const openDocument = this.findOpenTextDocument(mcmetaPath);
    const metadata = openDocument
      ? parsePackMetadataSafely(openDocument.getText())
      : readPackMetadata(packRoot, { pathExists: fileName => this.getPathExists(fileName) });
    this.packMetadataCache.set(key, { version, value: metadata });
    return metadata;
  }

  getResourceRootCandidates(request: ResourceResolveRequest, resourcePath: string, namespace: string): string[] {
    const key = [
      normalizePathKey(request.sourceFileName),
      request.source,
      request.target,
      namespace,
      resourcePath,
      normalizeOptionalPath(request.defaultAssetsPath),
      (request.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|"),
      this.configurationVersion
    ].join("\0");
    return this.getGenerationalValue("resourceRootCandidates", this.resourceRootCandidatesCache, key, () =>
      getDocumentResourceRootCandidates(
        request.sourceFileName,
        request.source,
        request.defaultAssetsPath,
        namespace,
        request.target,
        {
          pathExists: fileName => this.getPathExists(fileName),
          getPackRoot: fileName => this.getPackRoot(fileName),
          getPackMetadata: packRoot => this.getPackMetadata(packRoot),
          resourcePackRoots: request.resourcePackRoots,
          resourcePath
        }
      ));
  }

  resolveResourcePath(request: ResourceResolveRequest): string | null {
    const location = this.getResourceLocation(request.resourcePath, request.targetFileExtension);
    if (!location.isValid) {
      return null;
    }

    const normalizedResourcePath = path.posix.join(
      request.target.replaceAll("\\", "/"),
      location.resourcePath.replaceAll(path.sep, "/")
    );
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
      this.configurationVersion
    ].join("\0");
    const cached = this.resourceResolutionCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("resourceResolution");
      return cached.value;
    }

    this.miss("resourceResolution");
    const candidates = this.getResourceRootCandidates(request, normalizedResourcePath, location.namespace)
      .map(root => path.join(root, location.resourcePath));
    const resolvedPath = unique(candidates).find(candidate => this.getPathExists(candidate)) ?? null;
    this.resourceResolutionCache.set(key, { generation: this.resourceFsGeneration, value: resolvedPath });
    this.resourceResolutionDependencies.register(key, [
      request.sourceFileName,
      ...candidates
    ]);
    return resolvedPath;
  }

  getResourceLocation(resourcePath: string, targetFileExtension: string | null): ResourceLocation {
    const key = `${resourcePath}\0${targetFileExtension ?? ""}`;
    const cached = this.resourceLocationCache.get(key);
    if (cached) {
      this.hit("resourceLocation");
      return cached;
    }

    this.miss("resourceLocation");
    const location = parseResourceLocation(resourcePath, targetFileExtension);
    this.resourceLocationCache.set(key, location);
    return location;
  }

  getSoundEvents(soundsJsonPath: string): Set<string> | null {
    return this.getVersionedFileValue("soundEvents", this.soundEventsCache, soundsJsonPath, () => {
      const ast = this.getJsonFileAst(soundsJsonPath);
      return ast
        ? new Set(objectMembers(ast.body).map(member => memberName(member)).filter((name): name is string => Boolean(name)))
        : null;
    });
  }

  getPngMetadata(fileName: string): PngMetadata | null {
    return this.getVersionedFileValue("pngMetadata", this.pngMetadataCache, fileName, () => readPngFileMetadata(fileName));
  }

  getOggMetadata(fileName: string): OggMetadata | null {
    return this.getVersionedFileValue("oggMetadata", this.oggMetadataCache, fileName, () => readOggFileMetadata(fileName));
  }

  getModelParentChain(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): CachedModelDocument[] {
    const key = this.modelCacheKey(document, source, configuration);
    const cached = this.modelParentChainCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("modelParentChain");
      return cached.value;
    }

    this.miss("modelParentChain");
    const chain = loadModelParentChain(this, document.fileName, ast, source, configuration);
    this.modelParentChainCache.set(key, { generation: this.resourceFsGeneration, value: chain });
    this.modelCacheDependencies.register(`chain\0${key}`, chain.map(model => model.fileName));
    return chain;
  }

  getModelTextureVariableDefinitions(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): ReadonlyMap<string, CachedTextureVariableDefinition> {
    const key = this.modelCacheKey(document, source, configuration);
    const cached = this.modelTextureDefinitionsCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("modelTextureDefinitions");
      return cached.value;
    }

    this.miss("modelTextureDefinitions");
    const chain = this.getModelParentChain(document, ast, configuration, source);
    const definitions = collectModelTextureVariableDefinitions(chain);
    this.modelTextureDefinitionsCache.set(key, { generation: this.resourceFsGeneration, value: definitions });
    this.modelCacheDependencies.register(`definitions\0${key}`, chain.map(model => model.fileName));
    return definitions;
  }

  invalidateAll(): void {
    this.resourceFsGeneration++;
    this.resourceIndexGeneration++;
    this.pathExistsCache.clear();
    this.directoryEntriesCache.clear();
    this.directoryEntriesSyncCache.clear();
    this.documentAstCache.clear();
    this.fileAstCache.clear();
    this.resourceLocationCache.clear();
    this.packRootCache.clear();
    this.packMetadataCache.clear();
    this.resourceRootCandidatesCache.clear();
    this.resourceResolutionCache.clear();
    this.resourceResolutionDependencies.clear();
    this.soundEventsCache.clear();
    this.oggMetadataCache.clear();
    this.pngMetadataCache.clear();
    this.modelParentChainCache.clear();
    this.modelTextureDefinitionsCache.clear();
    this.modelCacheDependencies.clear();
  }

  invalidatePath(fileName: string): void {
    const key = normalizePathKey(fileName);
    this.resourceIndexGeneration++;
    this.pathExistsCache.delete(key);
    this.fileAstCache.delete(key);
    this.documentAstCache.delete(key);
    this.soundEventsCache.delete(key);
    this.oggMetadataCache.delete(key);
    this.pngMetadataCache.delete(key);
    this.deleteDirectoryEntriesForAncestors(fileName);

    if (/[\\/]pack\.mcmeta$/i.test(fileName)) {
      this.packMetadataCache.delete(normalizePathKey(path.dirname(fileName)));
      this.packRootCache.clear();
      this.resourceRootCandidatesCache.clear();
      this.resourceResolutionCache.clear();
      this.resourceResolutionDependencies.clear();
    } else {
      this.deleteResourceResolutionDependenciesForPath(key);
    }

    this.deleteModelCacheDependenciesForPath(key);
  }

  invalidateDocument(document: CacheTextDocument): void {
    this.documentAstCache.delete(documentKey(document));
    this.fileAstCache.delete(normalizePathKey(document.fileName));
    this.soundEventsCache.delete(normalizePathKey(document.fileName));
    this.oggMetadataCache.delete(normalizePathKey(document.fileName));
    this.deleteModelCacheDependenciesForPath(normalizePathKey(document.fileName));
  }

  invalidateConfiguration(): void {
    this.configurationVersion++;
    this.resourceRootCandidatesCache.clear();
    this.resourceResolutionCache.clear();
    this.resourceResolutionDependencies.clear();
    this.directoryEntriesCache.clear();
    this.directoryEntriesSyncCache.clear();
    this.modelParentChainCache.clear();
    this.modelTextureDefinitionsCache.clear();
    this.modelCacheDependencies.clear();
  }

  getStats(): CacheStatsSnapshot {
    return {
      configurationVersion: this.configurationVersion,
      resourceFsGeneration: this.resourceFsGeneration,
      sizes: {
        pathExists: this.pathExistsCache.size,
        directoryEntries: this.directoryEntriesCache.size,
        directoryEntriesSync: this.directoryEntriesSyncCache.size,
        documentAst: this.documentAstCache.size,
        fileAst: this.fileAstCache.size,
        resourceLocation: this.resourceLocationCache.size,
        packRoot: this.packRootCache.size,
        packMetadata: this.packMetadataCache.size,
        resourceRootCandidates: this.resourceRootCandidatesCache.size,
        resourceResolution: this.resourceResolutionCache.size,
        soundEvents: this.soundEventsCache.size,
        oggMetadata: this.oggMetadataCache.size,
        pngMetadata: this.pngMetadataCache.size,
        modelParentChain: this.modelParentChainCache.size,
        modelTextureDefinitions: this.modelTextureDefinitionsCache.size
      },
      hits: Object.fromEntries(this.hits),
      misses: Object.fromEntries(this.misses)
    };
  }

  private async readDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    try {
      return await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  private findOpenTextDocument(fileName: string): CacheTextDocument | null {
    return this.openTextDocumentProvider?.(fileName) ?? null;
  }

  private getGenerationalValue<T>(cacheName: string, cache: LruCache<string, CacheEntry<T>>, key: string, compute: () => T): T {
    const cached = cache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit(cacheName);
      return cached.value;
    }

    this.miss(cacheName);
    const value = compute();
    cache.set(key, { generation: this.resourceFsGeneration, value });
    return value;
  }

  private getVersionedFileValue<T>(cacheName: string, cache: LruCache<string, VersionedCacheEntry<T>>, fileName: string, compute: () => T): T {
    const key = normalizePathKey(fileName);
    const version = this.getFileVersion(fileName) ?? `missing:${this.resourceFsGeneration}`;
    const cached = cache.get(key);
    if (cached && cached.version === version) {
      this.hit(cacheName);
      return cached.value;
    }

    this.miss(cacheName);
    const value = compute();
    cache.set(key, { version, value });
    return value;
  }

  private modelCacheKey(document: CacheTextDocument, source: string, configuration: ResourceConfiguration): string {
    const version = typeof document.version === "number"
      ? `open:${document.version}`
      : this.getFileVersion(document.fileName) ?? "unknown";
    return [
      normalizePathKey(document.fileName),
      version,
      source,
      normalizeOptionalPath(configuration.defaultAssetsPath),
      (configuration.resourcePackRoots ?? []).map(root => normalizePathKey(root)).join("|"),
      this.configurationVersion
    ].join("\0");
  }

  private hit(cacheName: string): void {
    this.hits.set(cacheName, (this.hits.get(cacheName) ?? 0) + 1);
  }

  private miss(cacheName: string): void {
    this.misses.set(cacheName, (this.misses.get(cacheName) ?? 0) + 1);
  }

  private deleteResourceResolutionDependenciesForPath(fileKey: string): void {
    for (const cacheKey of this.resourceResolutionDependencies.affectedCacheKeys(fileKey)) {
      this.resourceResolutionCache.delete(cacheKey);
      this.resourceResolutionDependencies.release(cacheKey);
    }
  }

  private deleteModelCacheDependenciesForPath(fileKey: string): void {
    for (const cacheKey of this.modelCacheDependencies.affectedCacheKeys(fileKey)) {
      if (cacheKey.startsWith("chain\0")) {
        this.modelParentChainCache.delete(cacheKey.slice("chain\0".length));
      } else if (cacheKey.startsWith("definitions\0")) {
        this.modelTextureDefinitionsCache.delete(cacheKey.slice("definitions\0".length));
      }
      this.modelCacheDependencies.release(cacheKey);
    }
  }

  private deleteDirectoryEntriesForAncestors(fileName: string): void {
    let directory = path.dirname(path.normalize(fileName));
    const root = path.parse(directory).root;

    while (true) {
      const key = normalizePathKey(directory);
      this.directoryEntriesCache.delete(key);
      this.directoryEntriesSyncCache.delete(key);

      if (directory === root) {
        return;
      }
      directory = path.dirname(directory);
    }
  }
}

export const workspaceResourceCache = new WorkspaceResourceCache();

function parsePackMetadataSafely(text: string): PackMetadata {
  try {
    return parsePackMetadata(JSON.parse(text) as unknown);
  } catch {
    return emptyPackMetadata;
  }
}

function documentKey(document: CacheTextDocument): string {
  if (document.uri) {
    return document.uri.toString();
  }

  return normalizePathKey(document.fileName);
}

function normalizeOptionalPath(value: string | null | undefined): string {
  return value ? normalizePathKey(value) : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
