import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
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
import { ResourceCacheMetrics } from "./resourceCacheMetrics";
import type {
  CacheEntry,
  CacheTextDocument,
  ResourceCacheGenerationState,
  VersionedCacheEntry
} from "./resourceCacheTypes";

interface DocumentAstCacheEntry {
  fileName: string;
  version: number | undefined;
  ast: JsonDocumentNode | null;
}

export type OpenTextDocumentProvider = (fileName: string) => CacheTextDocument | null;

const emptyPackMetadata: PackMetadata = { overlays: [], filters: [] };

export class FileSystemResourceCache {
  private openTextDocumentProvider: OpenTextDocumentProvider | null = null;
  private readonly pathExistsCache = new LruCache<string, CacheEntry<boolean>>(8192);
  private readonly directoryEntriesCache = new LruCache<string, Promise<CacheEntry<Dirent[] | null>>>(1024);
  private readonly directoryEntriesSyncCache = new LruCache<string, CacheEntry<Dirent[] | null>>(1024);
  private readonly documentAstCache = new LruCache<string, DocumentAstCacheEntry>(1024);
  private readonly fileAstCache = new LruCache<string, VersionedCacheEntry<JsonDocumentNode | null>>(1024);
  private readonly packRootCache = new LruCache<string, CacheEntry<string | null>>(4096);
  private readonly packMetadataCache = new LruCache<string, VersionedCacheEntry<PackMetadata>>(256);
  private readonly soundEventsCache = new LruCache<string, VersionedCacheEntry<Set<string> | null>>(512);

  constructor(
    private readonly state: ResourceCacheGenerationState,
    private readonly metrics: ResourceCacheMetrics
  ) {}

  setOpenTextDocumentProvider(provider: OpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
  }

  getPathExists(fileName: string): boolean {
    return this.getGenerationalValue("pathExists", this.pathExistsCache, normalizePathKey(fileName), () => fs.existsSync(fileName));
  }

  getDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    const key = normalizePathKey(directory);
    const generation = this.state.getResourceFsGeneration();
    const cached = this.directoryEntriesCache.get(key);
    if (cached) {
      this.metrics.hit("directoryEntries");
      return cached.then(entry => entry.generation === this.state.getResourceFsGeneration()
        ? entry.value
        : this.readDirectoryEntries(directory));
    }

    this.metrics.miss("directoryEntries");
    const value = this.readDirectoryEntries(directory);
    this.directoryEntriesCache.set(key, value.then(entries => ({ generation, value: entries })));
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
    const version = this.getFileVersion(mcmetaPath) ?? `missing:${this.state.getResourceFsGeneration()}`;
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
    const key = normalizePathKey(fileName);
    const version = this.getFileVersion(fileName) ?? `missing:${this.state.getResourceFsGeneration()}`;
    const cached = cache.get(key);
    if (cached && cached.version === version) {
      this.metrics.hit(cacheName);
      return cached.value;
    }

    this.metrics.miss(cacheName);
    const value = compute();
    cache.set(key, { version, value });
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
