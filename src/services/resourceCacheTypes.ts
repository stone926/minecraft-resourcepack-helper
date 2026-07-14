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
