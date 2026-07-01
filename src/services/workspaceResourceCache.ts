import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  JsonDocumentNode,
  memberName,
  objectMembers,
  parseJsonAst,
  stringValue
} from "../utils/jsonAst";
import {
  getDocumentResourceRootCandidates,
  parsePackMetadata,
  parseResourceLocation,
  readPackMetadata,
  type ResourceLocation,
  type PackMetadata
} from "../utils/resourceLocation";
import { readPngMetadata, type PngMetadata } from "../utils/pngMetadata";

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

export interface CachedModelDocument {
  ast: JsonDocumentNode;
  fileName: string;
  source: string;
}

export interface CachedTextureVariableDefinition {
  fileName: string;
  line: number;
  character: number;
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

class LruCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(
    private readonly maxEntries: number,
    private readonly onEvict?: (key: K, value: V) => void
  ) { }

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.values.has(key)) {
      this.values.delete(key);
    }

    this.values.set(key, value);
    while (this.values.size > this.maxEntries) {
      const oldestKey = this.values.keys().next().value as K | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldestValue = this.values.get(oldestKey);
      this.values.delete(oldestKey);
      if (oldestValue !== undefined) {
        this.onEvict?.(oldestKey, oldestValue);
      }
    }
  }

  delete(key: K): void {
    const value = this.values.get(key);
    this.values.delete(key);
    if (value !== undefined) {
      this.onEvict?.(key, value);
    }
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.values) {
        this.onEvict(key, value);
      }
    }
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}

export class WorkspaceResourceCache {
  private configurationVersion = 0;
  private resourceFsGeneration = 0;
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
    key => this.clearResourceResolutionDependencies(key)
  );
  private readonly resourceResolutionDependenciesByPath = new Map<string, Set<string>>();
  private readonly resourceResolutionDependencyPathsByKey = new Map<string, Set<string>>();
  private readonly soundEventsCache = new LruCache<string, VersionedCacheEntry<Set<string> | null>>(512);
  private readonly pngMetadataCache = new LruCache<string, VersionedCacheEntry<PngMetadata | null>>(2048);
  private readonly modelParentChainCache = new LruCache<string, CacheEntry<CachedModelDocument[]>>(
    1024,
    key => this.clearModelCacheDependencies(`chain\0${key}`)
  );
  private readonly modelTextureDefinitionsCache = new LruCache<string, CacheEntry<ReadonlyMap<string, CachedTextureVariableDefinition>>>(
    1024,
    key => this.clearModelCacheDependencies(`definitions\0${key}`)
  );
  private readonly modelCacheDependenciesByPath = new Map<string, Set<string>>();
  private readonly modelCacheDependencyPathsByKey = new Map<string, Set<string>>();
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

  getPathExists(fileName: string): boolean {
    const key = pathKey(fileName);
    const cached = this.pathExistsCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("pathExists");
      return cached.value;
    }

    this.miss("pathExists");
    const exists = fs.existsSync(fileName);
    this.pathExistsCache.set(key, { generation: this.resourceFsGeneration, value: exists });
    return exists;
  }

  getDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    const key = pathKey(directory);
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
    const key = pathKey(directory);
    const cached = this.directoryEntriesSyncCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("directoryEntriesSync");
      return cached.value;
    }

    this.miss("directoryEntriesSync");
    let entries: Dirent[] | null;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      entries = null;
    }
    this.directoryEntriesSyncCache.set(key, { generation: this.resourceFsGeneration, value: entries });
    return entries;
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

    const key = pathKey(fileName);
    const version = this.getFileVersion(fileName) ?? `missing:${this.resourceFsGeneration}`;
    const cached = this.fileAstCache.get(key);
    if (cached && cached.version === version) {
      this.hit("fileAst");
      return cached.value;
    }

    this.miss("fileAst");
    let ast: JsonDocumentNode | null;
    try {
      ast = parseJsonAst(fs.readFileSync(fileName, "utf8"));
    } catch {
      ast = null;
    }
    this.fileAstCache.set(key, { version, value: ast });
    return ast;
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
    const key = pathKey(fileName);
    const cached = this.packRootCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("packRoot");
      return cached.value;
    }

    this.miss("packRoot");
    const packRoot = this.findPackRoot(fileName, null);
    this.packRootCache.set(key, { generation: this.resourceFsGeneration, value: packRoot });
    return packRoot;
  }

  getPackRootWithin(fileName: string, workspaceRoot: string): string | null {
    const normalizedWorkspaceRoot = path.normalize(workspaceRoot);
    const key = `${pathKey(fileName)}\0${pathKey(normalizedWorkspaceRoot)}`;
    const cached = this.packRootCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("packRoot");
      return cached.value;
    }

    this.miss("packRoot");
    const packRoot = this.findPackRoot(fileName, normalizedWorkspaceRoot);
    this.packRootCache.set(key, { generation: this.resourceFsGeneration, value: packRoot });
    return packRoot;
  }

  getPackMetadata(packRoot: string): PackMetadata {
    const key = pathKey(packRoot);
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
      pathKey(request.sourceFileName),
      request.source,
      request.target,
      namespace,
      resourcePath,
      normalizeOptionalPath(request.defaultAssetsPath),
      (request.resourcePackRoots ?? []).map(root => pathKey(root)).join("|"),
      this.configurationVersion
    ].join("\0");
    const cached = this.resourceRootCandidatesCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("resourceRootCandidates");
      return cached.value;
    }

    this.miss("resourceRootCandidates");
    const candidates = getDocumentResourceRootCandidates(
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
    );
    this.resourceRootCandidatesCache.set(key, { generation: this.resourceFsGeneration, value: candidates });
    return candidates;
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
      pathKey(request.sourceFileName),
      request.source,
      request.target,
      request.targetFileExtension ?? "",
      request.resourcePath,
      location.namespace,
      location.resourcePath,
      normalizeOptionalPath(request.defaultAssetsPath),
      (request.resourcePackRoots ?? []).map(root => pathKey(root)).join("|"),
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
    this.setResourceResolutionDependencies(key, [
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
    const key = pathKey(soundsJsonPath);
    const version = this.getFileVersion(soundsJsonPath) ?? `missing:${this.resourceFsGeneration}`;
    const cached = this.soundEventsCache.get(key);
    if (cached && cached.version === version) {
      this.hit("soundEvents");
      return cached.value;
    }

    this.miss("soundEvents");
    const ast = this.getJsonFileAst(soundsJsonPath);
    const events = ast
      ? new Set(objectMembers(ast.body).map(member => memberName(member)).filter((name): name is string => Boolean(name)))
      : null;
    this.soundEventsCache.set(key, { version, value: events });
    return events;
  }

  getPngMetadata(fileName: string): PngMetadata | null {
    const key = pathKey(fileName);
    const version = this.getFileVersion(fileName) ?? `missing:${this.resourceFsGeneration}`;
    const cached = this.pngMetadataCache.get(key);
    if (cached && cached.version === version) {
      this.hit("pngMetadata");
      return cached.value;
    }

    this.miss("pngMetadata");
    let metadata: PngMetadata | null;
    try {
      metadata = readPngMetadata(fs.readFileSync(fileName));
    } catch {
      metadata = null;
    }
    this.pngMetadataCache.set(key, { version, value: metadata });
    return metadata;
  }

  getModelParentChain(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): CachedModelDocument[] {
    const version = typeof document.version === "number"
      ? `open:${document.version}`
      : this.getFileVersion(document.fileName) ?? "unknown";
    const key = [
      pathKey(document.fileName),
      version,
      source,
      normalizeOptionalPath(configuration.defaultAssetsPath),
      (configuration.resourcePackRoots ?? []).map(root => pathKey(root)).join("|"),
      this.configurationVersion
    ].join("\0");
    const cached = this.modelParentChainCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("modelParentChain");
      return cached.value;
    }

    this.miss("modelParentChain");
    const chain = this.loadModelParentChain(document.fileName, ast, source, configuration);
    this.modelParentChainCache.set(key, { generation: this.resourceFsGeneration, value: chain });
    this.setModelCacheDependencies(`chain\0${key}`, chain.map(model => model.fileName));
    return chain;
  }

  getModelTextureVariableDefinitions(
    document: CacheTextDocument,
    ast: JsonDocumentNode,
    configuration: ResourceConfiguration,
    source = modelSourceForFile(document.fileName)
  ): ReadonlyMap<string, CachedTextureVariableDefinition> {
    const version = typeof document.version === "number"
      ? `open:${document.version}`
      : this.getFileVersion(document.fileName) ?? "unknown";
    const key = [
      pathKey(document.fileName),
      version,
      source,
      normalizeOptionalPath(configuration.defaultAssetsPath),
      (configuration.resourcePackRoots ?? []).map(root => pathKey(root)).join("|"),
      this.configurationVersion
    ].join("\0");
    const cached = this.modelTextureDefinitionsCache.get(key);
    if (cached && cached.generation === this.resourceFsGeneration) {
      this.hit("modelTextureDefinitions");
      return cached.value;
    }

    this.miss("modelTextureDefinitions");
    const chain = this.getModelParentChain(document, ast, configuration, source);
    const definitions = new Map<string, CachedTextureVariableDefinition>();
    for (const model of chain) {
      const textures = objectMembers(model.ast.body).find(member => memberName(member) === "textures");
      for (const texture of objectMembers(textures?.value)) {
        const name = memberName(texture);
        const location = texture.name?.loc ?? texture.loc;
        if (name && location && !definitions.has(name)) {
          definitions.set(name, {
            fileName: model.fileName,
            line: location.start.line - 1,
            character: location.start.column - 1
          });
        }
      }
    }

    this.modelTextureDefinitionsCache.set(key, { generation: this.resourceFsGeneration, value: definitions });
    this.setModelCacheDependencies(`definitions\0${key}`, chain.map(model => model.fileName));
    return definitions;
  }

  invalidateAll(): void {
    this.resourceFsGeneration++;
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
    this.resourceResolutionDependenciesByPath.clear();
    this.resourceResolutionDependencyPathsByKey.clear();
    this.soundEventsCache.clear();
    this.pngMetadataCache.clear();
    this.modelParentChainCache.clear();
    this.modelTextureDefinitionsCache.clear();
    this.modelCacheDependenciesByPath.clear();
    this.modelCacheDependencyPathsByKey.clear();
  }

  invalidatePath(fileName: string): void {
    const key = pathKey(fileName);
    this.pathExistsCache.delete(key);
    this.fileAstCache.delete(key);
    this.documentAstCache.delete(key);
    this.soundEventsCache.delete(key);
    this.pngMetadataCache.delete(key);
    this.directoryEntriesCache.delete(pathKey(path.dirname(fileName)));
    this.directoryEntriesSyncCache.delete(pathKey(path.dirname(fileName)));

    if (/[\\/]pack\.mcmeta$/i.test(fileName)) {
      this.packMetadataCache.delete(pathKey(path.dirname(fileName)));
      this.packRootCache.clear();
      this.resourceRootCandidatesCache.clear();
      this.resourceResolutionCache.clear();
      this.resourceResolutionDependenciesByPath.clear();
      this.resourceResolutionDependencyPathsByKey.clear();
    } else {
      this.deleteResourceResolutionDependenciesForPath(key);
    }

    this.deleteModelCacheDependenciesForPath(key);
  }

  invalidateDocument(document: CacheTextDocument): void {
    this.documentAstCache.delete(documentKey(document));
    this.fileAstCache.delete(pathKey(document.fileName));
    this.soundEventsCache.delete(pathKey(document.fileName));
    this.deleteModelCacheDependenciesForPath(pathKey(document.fileName));
  }

  invalidateConfiguration(): void {
    this.configurationVersion++;
    this.resourceRootCandidatesCache.clear();
    this.resourceResolutionCache.clear();
    this.resourceResolutionDependenciesByPath.clear();
    this.resourceResolutionDependencyPathsByKey.clear();
    this.directoryEntriesCache.clear();
    this.directoryEntriesSyncCache.clear();
    this.modelParentChainCache.clear();
    this.modelTextureDefinitionsCache.clear();
    this.modelCacheDependenciesByPath.clear();
    this.modelCacheDependencyPathsByKey.clear();
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

  private findPackRoot(fileName: string, stopAt: string | null): string | null {
    let current = path.dirname(path.normalize(fileName));
    const root = path.parse(current).root;
    const normalizedStopAt = stopAt ? path.normalize(stopAt) : null;

    while (true) {
      if (this.getPathExists(path.join(current, "pack.mcmeta"))) {
        return current;
      }

      if (current === root || (normalizedStopAt && isSamePath(current, normalizedStopAt))) {
        return null;
      }

      current = path.dirname(current);
    }
  }

  private loadModelParentChain(
    fileName: string,
    ast: JsonDocumentNode,
    source: string,
    configuration: ResourceConfiguration
  ): CachedModelDocument[] {
    const models: CachedModelDocument[] = [{
      ast,
      fileName,
      source
    }];
    const visited = new Set([pathKey(fileName)]);

    while (models.length <= 11) {
      const current = models[models.length - 1];
      const parent = findParentModel(current.ast);
      if (!parent) {
        break;
      }

      const parentFileName = this.resolveResourcePath({
        resourcePath: parent,
        sourceFileName: current.fileName,
        target: "models",
        source: current.source,
        targetFileExtension: "json",
        defaultAssetsPath: configuration.defaultAssetsPath,
        resourcePackRoots: configuration.resourcePackRoots
      });
      if (!parentFileName) {
        break;
      }

      const parentKey = pathKey(parentFileName);
      if (visited.has(parentKey)) {
        break;
      }
      visited.add(parentKey);

      const parentAst = this.getJsonFileAst(parentFileName);
      if (!parentAst) {
        break;
      }

      models.push({
        ast: parentAst,
        fileName: parentFileName,
        source: modelSourceForFile(parentFileName)
      });
    }

    return models;
  }

  private hit(cacheName: string): void {
    this.hits.set(cacheName, (this.hits.get(cacheName) ?? 0) + 1);
  }

  private miss(cacheName: string): void {
    this.misses.set(cacheName, (this.misses.get(cacheName) ?? 0) + 1);
  }

  private setResourceResolutionDependencies(cacheKey: string, fileNames: string[]): void {
    this.clearResourceResolutionDependencies(cacheKey);
    const dependencyKeys = new Set(fileNames.map(fileName => pathKey(fileName)));
    this.resourceResolutionDependencyPathsByKey.set(cacheKey, dependencyKeys);
    for (const dependencyKey of dependencyKeys) {
      const cacheKeys = this.resourceResolutionDependenciesByPath.get(dependencyKey);
      if (cacheKeys) {
        cacheKeys.add(cacheKey);
      } else {
        this.resourceResolutionDependenciesByPath.set(dependencyKey, new Set([cacheKey]));
      }
    }
  }

  private deleteResourceResolutionDependenciesForPath(fileKey: string): void {
    const cacheKeys = this.resourceResolutionDependenciesByPath.get(fileKey);
    if (!cacheKeys) {
      return;
    }

    for (const cacheKey of [...cacheKeys]) {
      this.resourceResolutionCache.delete(cacheKey);
      this.clearResourceResolutionDependencies(cacheKey);
    }
  }

  private clearResourceResolutionDependencies(cacheKey: string): void {
    const dependencyKeys = this.resourceResolutionDependencyPathsByKey.get(cacheKey);
    if (!dependencyKeys) {
      return;
    }

    for (const dependencyKey of dependencyKeys) {
      const cacheKeys = this.resourceResolutionDependenciesByPath.get(dependencyKey);
      cacheKeys?.delete(cacheKey);
      if (cacheKeys?.size === 0) {
        this.resourceResolutionDependenciesByPath.delete(dependencyKey);
      }
    }
    this.resourceResolutionDependencyPathsByKey.delete(cacheKey);
  }

  private setModelCacheDependencies(cacheKey: string, fileNames: string[]): void {
    this.clearModelCacheDependencies(cacheKey);
    const dependencyKeys = new Set(fileNames.map(fileName => pathKey(fileName)));
    this.modelCacheDependencyPathsByKey.set(cacheKey, dependencyKeys);
    for (const dependencyKey of dependencyKeys) {
      const cacheKeys = this.modelCacheDependenciesByPath.get(dependencyKey);
      if (cacheKeys) {
        cacheKeys.add(cacheKey);
      } else {
        this.modelCacheDependenciesByPath.set(dependencyKey, new Set([cacheKey]));
      }
    }
  }

  private deleteModelCacheDependenciesForPath(fileKey: string): void {
    const cacheKeys = this.modelCacheDependenciesByPath.get(fileKey);
    if (!cacheKeys) {
      return;
    }

    for (const cacheKey of [...cacheKeys]) {
      if (cacheKey.startsWith("chain\0")) {
        this.modelParentChainCache.delete(cacheKey.slice("chain\0".length));
      } else if (cacheKey.startsWith("definitions\0")) {
        this.modelTextureDefinitionsCache.delete(cacheKey.slice("definitions\0".length));
      }
      this.clearModelCacheDependencies(cacheKey);
    }
  }

  private clearModelCacheDependencies(cacheKey: string): void {
    const dependencyKeys = this.modelCacheDependencyPathsByKey.get(cacheKey);
    if (!dependencyKeys) {
      return;
    }

    for (const dependencyKey of dependencyKeys) {
      const cacheKeys = this.modelCacheDependenciesByPath.get(dependencyKey);
      cacheKeys?.delete(cacheKey);
      if (cacheKeys?.size === 0) {
        this.modelCacheDependenciesByPath.delete(dependencyKey);
      }
    }
    this.modelCacheDependencyPathsByKey.delete(cacheKey);
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

function findParentModel(ast: JsonDocumentNode): string | null {
  const parent = objectMembers(ast.body).find(member => memberName(member) === "parent");
  return stringValue(parent?.value) ?? null;
}

function modelSourceForFile(fileName: string): string {
  if (/[\\/]models[\\/]item[\\/]/i.test(fileName)) {
    return "models/item";
  }

  if (/[\\/]models[\\/]block[\\/]/i.test(fileName)) {
    return "models/block";
  }

  return "models";
}

function documentKey(document: CacheTextDocument): string {
  if (document.uri) {
    return document.uri.toString();
  }

  return pathKey(document.fileName);
}

function pathKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeOptionalPath(value: string | null | undefined): string {
  return value ? pathKey(value) : "";
}

function isSamePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
