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

export type { ResourceConfiguration } from "../utils/resourceConfigurationTypes";

export interface CacheStatsSnapshot {
  configurationVersion: number;
  resourceFsGeneration: number;
  sizes: Record<string, number>;
  hits: Record<string, number>;
  misses: Record<string, number>;
}

export interface ResourceCacheGenerationState {
  getConfigurationVersion(): number;
  getResourceFsGeneration(): number;
}

export interface CacheEntry<T> {
  generation: number;
  value: T;
}

export interface VersionedCacheEntry<T> {
  version: string;
  value: T;
}

/** File-version string protocol shared by every file-backed cache layer. */
export function openDocumentFileVersion(documentVersion: number): string {
  return `open:${documentVersion}`;
}

export function missingFileVersion(resourceFsGeneration: number): string {
  return `missing:${resourceFsGeneration}`;
}

export interface CacheMetricsHost {
  hit(cacheName: string): void;
  miss(cacheName: string): void;
}

interface VersionedValueCache<T> {
  get(key: string): VersionedCacheEntry<T> | undefined;
  set(key: string, entry: VersionedCacheEntry<T>): void;
}

export function getCachedVersionedValue<T>(
  metrics: CacheMetricsHost,
  cacheName: string,
  cache: VersionedValueCache<T>,
  key: string,
  version: string,
  compute: () => T
): T {
  const cached = cache.get(key);
  if (cached && cached.version === version) {
    metrics.hit(cacheName);
    return cached.value;
  }

  metrics.miss(cacheName);
  const value = compute();
  cache.set(key, { version, value });
  return value;
}
