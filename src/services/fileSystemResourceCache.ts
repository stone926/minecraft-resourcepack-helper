import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  ancestorPackMetadataCandidates,
  findPackRoot,
  normalizePathKey,
  parsePackMetadata,
  readPackMetadata,
  type PackMetadata
} from "../../packages/mc-assets/src";
import {
  type JsonDocumentNode,
  memberName,
  objectMembers,
  parseJsonAst
} from "../utils/jsonAst";
import { LruCache } from "./lruCache";
import {
  FileFreshnessPolicy,
  type FileFreshnessPolicyOptions,
  type WatcherTrustProvider
} from "./fileFreshnessPolicy";
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import {
  getCachedVersionedValue,
  missingFileVersion,
  openDocumentFileVersion,
  type CacheEntry,
  type CacheTextDocument,
  type ResourceCacheGenerationState,
  type VersionedCacheEntry
} from "./resourceCacheTypes";

interface DocumentAstCacheEntry {
  fileName: string;
  version: number | undefined;
  ast: JsonDocumentNode | null;
}

interface PathExistsCacheEntry extends CacheEntry<boolean> {
  verifiedAt: number;
}

interface FreshnessCacheEntry<T> extends CacheEntry<T> {
  readonly verificationPaths: readonly string[];
  readonly verifiedAt: number;
}

export type OpenTextDocumentProvider = (fileName: string) => CacheTextDocument | null;

const emptyPackMetadata: PackMetadata = { overlays: [], filters: [] };

export class FileSystemResourceCache {
  private openTextDocumentProvider: OpenTextDocumentProvider | null = null;
  private readonly pathExistsCache = new LruCache<string, PathExistsCacheEntry>(8192);
  private readonly directoryEntriesCache = new LruCache<string, VersionedCacheEntry<Promise<Dirent[] | null>>>(1024);
  private readonly directoryEntriesSyncCache = new LruCache<string, VersionedCacheEntry<Dirent[] | null>>(1024);
  private readonly documentAstCache = new LruCache<string, DocumentAstCacheEntry>(1024);
  private readonly fileAstCache = new LruCache<string, VersionedCacheEntry<JsonDocumentNode | null>>(1024);
  private readonly packRootCache = new LruCache<string, FreshnessCacheEntry<string | null>>(4096);
  private readonly packMetadataCache = new LruCache<string, VersionedCacheEntry<PackMetadata>>(256);
  private readonly soundEventsCache = new LruCache<string, VersionedCacheEntry<Set<string> | null>>(512);

  constructor(
    private readonly state: ResourceCacheGenerationState,
    private readonly metrics: ResourceCacheMetrics,
    freshnessOptions: FileFreshnessPolicyOptions = {}
  ) {
    this.freshness = new FileFreshnessPolicy(freshnessOptions);
  }

  private readonly freshness: FileFreshnessPolicy;

  setOpenTextDocumentProvider(provider: OpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
  }

  setWatcherTrustProvider(provider: WatcherTrustProvider | null): void {
    this.freshness.setWatcherTrustProvider(provider);
    this.invalidateAll();
  }

  getPathExists(fileName: string): boolean {
    const key = normalizePathKey(fileName);
    const generation = this.state.getResourceFsGeneration();
    const cached = this.pathExistsCache.get(key);
    if (
      cached
      && cached.generation === generation
      && this.freshness.canReuseVerifiedValue(fileName, cached.verifiedAt)
    ) {
      this.metrics.hit("pathExists");
      return cached.value;
    }

    this.metrics.miss("pathExists");
    const value = fs.existsSync(fileName);
    this.pathExistsCache.set(key, {
      generation,
      value,
      verifiedAt: this.freshness.verificationTimestamp()
    });
    return value;
  }

  getDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    const key = normalizePathKey(directory);
    const version = this.getFileVersion(directory) ?? missingFileVersion(this.state.getResourceFsGeneration());
    const cached = this.directoryEntriesCache.get(key);
    if (cached && cached.version === version) {
      this.metrics.hit("directoryEntries");
      return cached.value;
    }

    this.metrics.miss("directoryEntries");
    const value = this.readDirectoryEntries(directory);
    this.directoryEntriesCache.set(key, { version, value });
    return value;
  }

  getDirectoryEntriesSync(directory: string): Dirent[] | null {
    const key = normalizePathKey(directory);
    const version = this.getFileVersion(directory) ?? missingFileVersion(this.state.getResourceFsGeneration());
    const cached = this.directoryEntriesSyncCache.get(key);
    if (cached && cached.version === version) {
      this.metrics.hit("directoryEntriesSync");
      return cached.value;
    }
    this.metrics.miss("directoryEntriesSync");
    let value: Dirent[] | null;
    try {
      value = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      value = null;
    }
    this.directoryEntriesSyncCache.set(key, { version, value });
    return value;
  }

  getJsonAst(document: CacheTextDocument): JsonDocumentNode | null {
    const key = documentKey(document);
    const cached = this.documentAstCache.get(key);
    if (cached && cached.fileName === document.fileName && cached.version === document.version) {
      this.metrics.hit("documentAst");
      return cached.ast;
    }

    this.metrics.miss("documentAst");
    const ast = parseJsonAst(document.getText());
    this.documentAstCache.set(key, { fileName: document.fileName, version: document.version, ast });
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
      return openDocumentFileVersion(openDocument.version);
    }

    return this.freshness.getFileVersion(fileName);
  }

  canReuseVerifiedPaths(fileNames: readonly string[], verifiedAt: number): boolean {
    return this.freshness.canReuseVerifiedPaths(fileNames, verifiedAt);
  }

  verificationTimestamp(): number {
    return this.freshness.verificationTimestamp();
  }

  getPackRoot(fileName: string): string | null {
    return this.getFreshGenerationalValue(
      "packRoot",
      this.packRootCache,
      normalizePathKey(fileName),
      ancestorPackMetadataCandidates(fileName),
      () => findPackRoot(fileName, { pathExists: candidate => this.getPathExists(candidate) })
    );
  }

  getPackRootWithin(fileName: string, workspaceRoot: string): string | null {
    const normalizedWorkspaceRoot = path.normalize(workspaceRoot);
    const key = `${normalizePathKey(fileName)}\0${normalizePathKey(normalizedWorkspaceRoot)}`;
    return this.getFreshGenerationalValue(
      "packRoot",
      this.packRootCache,
      key,
      ancestorPackMetadataCandidates(fileName, normalizedWorkspaceRoot),
      () => findPackRoot(fileName, {
        pathExists: candidate => this.getPathExists(candidate),
        stopAt: normalizedWorkspaceRoot
      })
    );
  }

  getPackMetadata(packRoot: string): PackMetadata {
    const key = normalizePathKey(packRoot);
    const mcmetaPath = path.join(packRoot, "pack.mcmeta");
    const version = this.getFileVersion(mcmetaPath) ?? missingFileVersion(this.state.getResourceFsGeneration());
    const cached = this.packMetadataCache.get(key);
    if (cached && cached.version === version) {
      this.metrics.hit("packMetadata");
      return cached.value;
    }

    this.metrics.miss("packMetadata");
    const openDocument = this.findOpenTextDocument(mcmetaPath);
    const metadata = openDocument
      ? parsePackMetadataSafely(openDocument.getText())
      : readPackMetadata(packRoot, { pathExists: fileName => this.getPathExists(fileName) });
    this.packMetadataCache.set(key, { version, value: metadata });
    return metadata;
  }

  getSoundEvents(soundsJsonPath: string): Set<string> | null {
    return this.getVersionedFileValue("soundEvents", this.soundEventsCache, soundsJsonPath, () => {
      const ast = this.getJsonFileAst(soundsJsonPath);
      return ast
        ? new Set(objectMembers(ast.body).map(member => memberName(member)).filter((name): name is string => Boolean(name)))
        : null;
    });
  }

  invalidateAll(): void {
    this.freshness.invalidateAll();
    this.pathExistsCache.clear();
    this.directoryEntriesCache.clear();
    this.directoryEntriesSyncCache.clear();
    this.documentAstCache.clear();
    this.fileAstCache.clear();
    this.packRootCache.clear();
    this.packMetadataCache.clear();
    this.soundEventsCache.clear();
  }

  invalidatePath(fileName: string): void {
    this.freshness.invalidatePath(fileName);
    const key = normalizePathKey(fileName);
    this.pathExistsCache.delete(key);
    this.fileAstCache.delete(key);
    this.documentAstCache.delete(key);
    this.soundEventsCache.delete(key);
    this.deleteDirectoryEntriesForAncestors(fileName);

    if (/[\\/]pack\.mcmeta$/i.test(fileName)) {
      this.packMetadataCache.delete(normalizePathKey(path.dirname(fileName)));
      this.packRootCache.clear();
    }
  }

  invalidateDocument(document: CacheTextDocument): void {
    this.freshness.invalidatePath(document.fileName);
    this.documentAstCache.delete(documentKey(document));
    this.fileAstCache.delete(normalizePathKey(document.fileName));
    this.soundEventsCache.delete(normalizePathKey(document.fileName));
    if (/[\\/]pack\.mcmeta$/i.test(document.fileName)) {
      this.packMetadataCache.delete(normalizePathKey(path.dirname(document.fileName)));
    }
  }

  invalidateConfiguration(): void {
    this.directoryEntriesCache.clear();
    this.directoryEntriesSyncCache.clear();
  }

  getSizes(): Record<string, number> {
    return {
      pathExists: this.pathExistsCache.size,
      directoryEntries: this.directoryEntriesCache.size,
      directoryEntriesSync: this.directoryEntriesSyncCache.size,
      documentAst: this.documentAstCache.size,
      fileAst: this.fileAstCache.size,
      packRoot: this.packRootCache.size,
      packMetadata: this.packMetadataCache.size,
      soundEvents: this.soundEventsCache.size
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

  private getGenerationalValue<T>(
    cacheName: string,
    cache: LruCache<string, CacheEntry<T>>,
    key: string,
    compute: () => T
  ): T {
    const generation = this.state.getResourceFsGeneration();
    const cached = cache.get(key);
    if (cached && cached.generation === generation) {
      this.metrics.hit(cacheName);
      return cached.value;
    }

    this.metrics.miss(cacheName);
    const value = compute();
    cache.set(key, { generation, value });
    return value;
  }

  private getVersionedFileValue<T>(
    cacheName: string,
    cache: LruCache<string, VersionedCacheEntry<T>>,
    fileName: string,
    compute: () => T
  ): T {
    const version = this.getFileVersion(fileName) ?? missingFileVersion(this.state.getResourceFsGeneration());
    return getCachedVersionedValue(this.metrics, cacheName, cache, normalizePathKey(fileName), version, compute);
  }

  private getFreshGenerationalValue<T>(
    cacheName: string,
    cache: LruCache<string, FreshnessCacheEntry<T>>,
    key: string,
    verificationPaths: readonly string[],
    compute: () => T
  ): T {
    const generation = this.state.getResourceFsGeneration();
    const cached = cache.get(key);
    if (
      cached
      && cached.generation === generation
      && this.freshness.canReuseVerifiedPaths(cached.verificationPaths, cached.verifiedAt)
    ) {
      this.metrics.hit(cacheName);
      return cached.value;
    }

    this.metrics.miss(cacheName);
    const value = compute();
    cache.set(key, {
      generation,
      value,
      verificationPaths,
      verifiedAt: this.freshness.verificationTimestamp()
    });
    return value;
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

function parsePackMetadataSafely(text: string): PackMetadata {
  try {
    return parsePackMetadata(JSON.parse(text) as unknown);
  } catch {
    return emptyPackMetadata;
  }
}

function documentKey(document: CacheTextDocument): string {
  return document.uri ? document.uri.toString() : normalizePathKey(document.fileName);
}
