import { resolveCitPackRoot } from "./citPaths";
import { qualifyMinecraftResourceId } from "../../packages/mc-assets/src";
import * as path from "node:path";
import {
  getAssetsRootPathCandidates,
  normalizePathKey,
  uniqueValues
} from "../../packages/mc-assets/src";
import { LruCache } from "../services/lruCache";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import {
  loadCitBuiltinResourceCatalog,
  type CitBuiltinResourceCatalog
} from "./citBuiltinResourceCatalog";

export interface CitResourceIdConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface CitResourceIds {
  items: string[];
  enchantments: string[];
}

interface CachedResourceIds {
  ids: CitResourceIds;
}

interface ResourceIdCacheContext {
  cacheKey: string;
  generation: number;
  configurationVersion: number;
  documentPackRoot: string | null;
}

interface PendingWarmResourceIds {
  promise: Promise<CitResourceIds>;
  readyCallbacks: Map<string, () => void>;
}

export interface CitResourceIdsReadySubscriber {
  /** Stable consumer identity; a newer callback replaces an older pending one. */
  key: string;
  onReady(): void;
}

const maxCachedResourceIdContexts = 64;

export class CitResourceIdService {
  private readonly cached = new LruCache<string, CachedResourceIds>(maxCachedResourceIdContexts);
  private readonly pendingWarmups = new Map<string, PendingWarmResourceIds>();
  private builtinCatalog: CitBuiltinResourceCatalog | undefined;
  private builtinResourceIds: CitResourceIds | undefined;

  public constructor(
    private readonly loadBuiltinCatalog: () => CitBuiltinResourceCatalog =
      loadCitBuiltinResourceCatalog
  ) {}

  getResourceIds(documentFileName: string, configuration: CitResourceIdConfiguration = {}): CitResourceIds {
    const context = this.getCacheContext(documentFileName, configuration);
    const cached = this.getCachedResourceIdsForContext(context);
    if (cached) {
      return cached;
    }

    const ids = collectResourceIds(
      context.documentPackRoot,
      configuration,
      this.getBuiltinCatalog()
    );
    this.cached.set(this.getWarmupKey(context), { ids });
    return ids;
  }

  getCachedResourceIds(documentFileName: string, configuration: CitResourceIdConfiguration = {}): CitResourceIds | null {
    return this.getCachedResourceIdsForContext(this.getCacheContext(documentFileName, configuration));
  }

  getBuiltinResourceIds(): CitResourceIds {
    const catalog = this.getBuiltinCatalog();
    return this.builtinResourceIds ??= {
      items: catalog.items,
      enchantments: catalog.enchantments
    };
  }

  /** Returns immediately for editor hot paths and schedules one shared warmup on a miss. */
  getResourceIdsForHotPath(
    documentFileName: string,
    configuration: CitResourceIdConfiguration = {},
    readySubscriber?: CitResourceIdsReadySubscriber
  ): CitResourceIds {
    const cached = this.getCachedResourceIds(documentFileName, configuration);
    if (cached) {
      return cached;
    }
    void this.warmResourceIds(documentFileName, configuration, readySubscriber).catch(error => {
      console.error("Failed to warm CIT resource IDs.", error);
    });
    return this.getBuiltinResourceIds();
  }

  warmResourceIds(
    documentFileName: string,
    configuration: CitResourceIdConfiguration = {},
    readySubscriber?: CitResourceIdsReadySubscriber
  ): Promise<CitResourceIds> {
    const context = this.getCacheContext(documentFileName, configuration);
    const cached = this.getCachedResourceIdsForContext(context);
    if (cached) {
      return Promise.resolve(cached);
    }

    const warmupKey = this.getWarmupKey(context);
    const pending = this.pendingWarmups.get(warmupKey);
    if (pending) {
      registerReadySubscriber(pending, readySubscriber);
      return pending.promise;
    }

    const readyCallbacks = new Map<string, () => void>();
    const warmup: PendingWarmResourceIds = {
      promise: new Promise<CitResourceIds>((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(this.getResourceIds(documentFileName, configuration));
          } catch (error) {
            reject(error);
          }
        }, 0);
      }),
      readyCallbacks
    };
    warmup.promise = warmup.promise.then(ids => {
      if (this.pendingWarmups.get(warmupKey) === warmup) {
        this.pendingWarmups.delete(warmupKey);
      }
      notifyReadySubscribers(warmup);
      return ids;
    }, error => {
      if (this.pendingWarmups.get(warmupKey) === warmup) {
        this.pendingWarmups.delete(warmupKey);
      }
      throw error;
    });
    registerReadySubscriber(warmup, readySubscriber);
    this.pendingWarmups.set(warmupKey, warmup);
    return warmup.promise;
  }

  normalizeItemId(value: string): string {
    return normalizeResourceId(value);
  }

  normalizeEnchantmentId(value: string): string {
    return normalizeResourceId(value);
  }

  isArmorItem(value: string): boolean {
    const id = normalizeResourceId(value);
    const catalog = this.getBuiltinCatalog();
    return catalog.armorSuffixes.some(suffix => id.endsWith(suffix));
  }

  private getCacheContext(documentFileName: string, configuration: CitResourceIdConfiguration): ResourceIdCacheContext {
    const documentPackRoot = resolveDocumentPackRoot(documentFileName);
    return {
      cacheKey: getCacheKey(documentPackRoot, configuration),
      generation: workspaceResourceCache.getResourceIndexGeneration(),
      configurationVersion: workspaceResourceCache.getConfigurationVersion(),
      documentPackRoot
    };
  }

  private getCachedResourceIdsForContext(context: ResourceIdCacheContext): CitResourceIds | null {
    return this.cached.get(this.getWarmupKey(context))?.ids ?? null;
  }

  private getWarmupKey(context: ResourceIdCacheContext): string {
    return [
      context.cacheKey,
      context.generation,
      context.configurationVersion
    ].join("\0");
  }

  private getBuiltinCatalog(): CitBuiltinResourceCatalog {
    return this.builtinCatalog ??= this.loadBuiltinCatalog();
  }
}

export const citResourceIdService = new CitResourceIdService();

function collectResourceIds(
  documentPackRoot: string | null,
  configuration: CitResourceIdConfiguration,
  builtinCatalog: CitBuiltinResourceCatalog
): CitResourceIds {
  const items = new Set(builtinCatalog.items);
  const enchantments = new Set(builtinCatalog.enchantments);
  const roots = getAssetsRoots(documentPackRoot, configuration);

  for (const assetsRoot of roots) {
    collectAssetJsonIds(assetsRoot, ["items"], items);
    collectAssetJsonIds(assetsRoot, ["models", "item"], items);
    collectDataJsonIds(path.dirname(assetsRoot), ["enchantment"], enchantments);
    collectDataJsonIds(path.dirname(assetsRoot), ["enchantments"], enchantments);
  }

  return {
    items: [...items].sort(),
    enchantments: [...enchantments].sort()
  };
}

function registerReadySubscriber(
  warmup: PendingWarmResourceIds,
  subscriber: CitResourceIdsReadySubscriber | undefined
): void {
  if (subscriber) {
    warmup.readyCallbacks.set(subscriber.key, subscriber.onReady);
  }
}

function notifyReadySubscribers(warmup: PendingWarmResourceIds): void {
  for (const callback of warmup.readyCallbacks.values()) {
    try {
      callback();
    } catch (error) {
      console.error("A CIT resource ID ready subscriber failed.", error);
    }
  }
  warmup.readyCallbacks.clear();
}

function collectAssetJsonIds(assetsRoot: string, directorySegments: string[], target: Set<string>): void {
  const namespaces = workspaceResourceCache.getDirectoryEntriesSync(assetsRoot) ?? [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    collectJsonIds(path.join(assetsRoot, namespace.name, ...directorySegments), namespace.name, "", target);
  }
}

function collectDataJsonIds(packRoot: string, directorySegments: string[], target: Set<string>): void {
  const dataRoot = path.join(packRoot, "data");
  const namespaces = workspaceResourceCache.getDirectoryEntriesSync(dataRoot) ?? [];
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    collectJsonIds(path.join(dataRoot, namespace.name, ...directorySegments), namespace.name, "", target);
  }
}

function collectJsonIds(directory: string, namespace: string, prefix: string, target: Set<string>, depth = 0): void {
  if (depth > 16) {
    return;
  }

  const entries = workspaceResourceCache.getDirectoryEntriesSync(directory);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsonIds(entryPath, namespace, joinResourcePath(prefix, entry.name), target, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const idPath = joinResourcePath(prefix, entry.name.slice(0, -".json".length));
      target.add(`${namespace}:${idPath}`);
    }
  }
}

function getAssetsRoots(
  documentPackRoot: string | null,
  configuration: CitResourceIdConfiguration
): string[] {
  const roots: string[] = [];
  if (documentPackRoot) {
    addAssetsRootCandidates(roots, documentPackRoot);
  }
  for (const root of configuration.resourcePackRoots ?? []) {
    addAssetsRootCandidates(roots, root);
  }
  if (configuration.defaultAssetsPath) {
    addAssetsRootCandidates(roots, configuration.defaultAssetsPath);
  }

  return uniqueValues(
    roots
      .filter(root => workspaceResourceCache.getDirectoryEntriesSync(root) !== null)
      .map(root => path.normalize(root))
  );
}

function addAssetsRootCandidates(roots: string[], candidate: string): void {
  roots.push(...getAssetsRootPathCandidates(candidate));
}

function normalizeResourceId(value: string): string {
  return qualifyMinecraftResourceId(value.trim());
}

function joinResourcePath(left: string, right: string): string {
  return left.length > 0 ? `${left}/${right}` : right;
}

function resolveDocumentPackRoot(documentFileName: string): string | null {
  return resolveCitPackRoot(
    documentFileName,
    fileName => workspaceResourceCache.getPackRoot(fileName)
  );
}

function getCacheKey(
  documentPackRoot: string | null,
  configuration: CitResourceIdConfiguration
): string {
  return JSON.stringify({
    documentPackRoot: documentPackRoot ? normalizePathKey(documentPackRoot) : null,
    defaultAssetsPath: configuration.defaultAssetsPath
      ? normalizePathKey(configuration.defaultAssetsPath)
      : null,
    resourcePackRoots: (configuration.resourcePackRoots ?? [])
      .map(root => normalizePathKey(root))
  });
}
