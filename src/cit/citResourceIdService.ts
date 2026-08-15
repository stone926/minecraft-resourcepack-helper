import { resolveCitPackRoot } from "./citPaths";
import { qualifyMinecraftResourceId } from "../../packages/mc-assets/src";
import { promises as fs } from "node:fs";
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
import {
  CitResourceIdInventoryState,
  citResourceIdInventoryState,
  type CitResourceIdInventoryChangeKind
} from "./citResourceIdInventory";

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
  cachedAt: number;
}

interface ResourceIdCacheContext {
  cacheKey: string;
  generation: number;
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
const defaultInventoryFreshnessTtlMs = 30_000;

export interface CitResourceIdServiceOptions {
  now?: () => number;
  inventoryFreshnessTtlMs?: number;
  inventoryState?: CitResourceIdInventoryState;
}

export class CitResourceIdService {
  private readonly cached = new LruCache<string, CachedResourceIds>(maxCachedResourceIdContexts);
  private readonly pendingWarmups = new Map<string, PendingWarmResourceIds>();
  private builtinCatalog: CitBuiltinResourceCatalog | undefined;
  private builtinResourceIds: CitResourceIds | undefined;
  private readonly now: () => number;
  private readonly inventoryFreshnessTtlMs: number;
  private readonly inventoryState: CitResourceIdInventoryState;

  public constructor(
    private readonly loadBuiltinCatalog: () => CitBuiltinResourceCatalog =
      loadCitBuiltinResourceCatalog,
    options: CitResourceIdServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.inventoryFreshnessTtlMs = Math.max(
      0,
      options.inventoryFreshnessTtlMs ?? defaultInventoryFreshnessTtlMs
    );
    this.inventoryState = options.inventoryState ?? citResourceIdInventoryState;
  }

  getResourceIds(
    documentFileName: string,
    configuration: CitResourceIdConfiguration = {}
  ): Promise<CitResourceIds> {
    return this.warmResourceIds(documentFileName, configuration);
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
    const context = this.getCacheContext(documentFileName, configuration);
    const cached = this.cached.get(this.getWarmupKey(context));
    if (cached && this.isFresh(cached)) {
      return cached.ids;
    }
    void this.warmResourceIds(documentFileName, configuration, readySubscriber).catch(error => {
      console.error("Failed to warm CIT resource IDs.", error);
    });
    // Watcher coverage is deliberately treated as incomplete. Keep the last
    // complete inventory visible while its TTL refresh runs so diagnostics and
    // completion do not briefly fall back to builtin-only IDs every interval.
    return cached?.ids ?? this.getBuiltinResourceIds();
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
      promise: collectResourceIdsAsync(
        context.documentPackRoot,
        configuration,
        this.getBuiltinCatalog()
      ).then(ids => {
        this.cached.set(warmupKey, { ids, cachedAt: this.now() });
        return ids;
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

  /**
   * Invalidates filename-derived IDs only when the inventory can change.
   * File content edits and unrelated resource files do not affect this index.
   */
  invalidatePath(
    fileName: string,
    kind: CitResourceIdInventoryChangeKind = "change"
  ): void {
    this.inventoryState.invalidatePath(fileName, kind);
  }

  /** Invalidates structural inventory state, for example after a directory operation. */
  invalidateAll(): void {
    this.inventoryState.invalidateAll();
  }

  private getCacheContext(documentFileName: string, configuration: CitResourceIdConfiguration): ResourceIdCacheContext {
    const documentPackRoot = resolveDocumentPackRoot(documentFileName);
    return {
      cacheKey: getCacheKey(documentPackRoot, configuration),
      generation: this.inventoryState.currentGeneration(),
      documentPackRoot
    };
  }

  private getCachedResourceIdsForContext(context: ResourceIdCacheContext): CitResourceIds | null {
    const key = this.getWarmupKey(context);
    const cached = this.cached.get(key);
    if (!cached) {
      return null;
    }
    if (!this.isFresh(cached)) {
      this.cached.delete(key);
      return null;
    }
    return cached.ids;
  }

  private isFresh(cached: CachedResourceIds): boolean {
    return this.now() - cached.cachedAt < this.inventoryFreshnessTtlMs;
  }

  private getWarmupKey(context: ResourceIdCacheContext): string {
    return [
      context.cacheKey,
      context.generation
    ].join("\0");
  }

  private getBuiltinCatalog(): CitBuiltinResourceCatalog {
    return this.builtinCatalog ??= this.loadBuiltinCatalog();
  }
}

export const citResourceIdService = new CitResourceIdService();

async function collectResourceIdsAsync(
  documentPackRoot: string | null,
  configuration: CitResourceIdConfiguration,
  builtinCatalog: CitBuiltinResourceCatalog
): Promise<CitResourceIds> {
  const items = new Set(builtinCatalog.items);
  const enchantments = new Set(builtinCatalog.enchantments);

  for (const assetsRoot of getInventoryAssetsRootCandidates(documentPackRoot, configuration)) {
    await collectAssetJsonIdsAsync(assetsRoot, ["items"], items);
    await collectAssetJsonIdsAsync(assetsRoot, ["models", "item"], items);
    await collectDataJsonIdsAsync(path.dirname(assetsRoot), ["enchantment"], enchantments);
    await collectDataJsonIdsAsync(path.dirname(assetsRoot), ["enchantments"], enchantments);
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

async function collectAssetJsonIdsAsync(
  assetsRoot: string,
  directorySegments: string[],
  target: Set<string>
): Promise<void> {
  const namespaces = await readDirectoryEntries(assetsRoot);
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    await collectJsonIdsAsync(
      path.join(assetsRoot, namespace.name, ...directorySegments),
      namespace.name,
      "",
      target
    );
  }
}

async function collectDataJsonIdsAsync(
  packRoot: string,
  directorySegments: string[],
  target: Set<string>
): Promise<void> {
  const dataRoot = path.join(packRoot, "data");
  const namespaces = await readDirectoryEntries(dataRoot);
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) {
      continue;
    }
    await collectJsonIdsAsync(
      path.join(dataRoot, namespace.name, ...directorySegments),
      namespace.name,
      "",
      target
    );
  }
}

async function collectJsonIdsAsync(
  directory: string,
  namespace: string,
  prefix: string,
  target: Set<string>,
  depth = 0
): Promise<void> {
  if (depth > 16) {
    return;
  }

  const entries = await readDirectoryEntries(directory);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonIdsAsync(
        entryPath,
        namespace,
        joinResourcePath(prefix, entry.name),
        target,
        depth + 1
      );
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const idPath = joinResourcePath(prefix, entry.name.slice(0, -".json".length));
      target.add(`${namespace}:${idPath}`);
    }
    if ((index + 1) % 512 === 0) {
      await yieldToEventLoop();
    }
  }
}

async function readDirectoryEntries(directory: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
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

function getInventoryAssetsRootCandidates(
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
  return uniqueValues(roots.map(root => path.normalize(root)));
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
