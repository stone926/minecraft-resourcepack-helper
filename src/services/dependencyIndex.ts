import { normalizePathKey } from "../../packages/mc-assets/src";

/**
 * Reverse-dependency index between cache keys and the file paths their cached
 * values were derived from. `register` records the dependency set of a cache
 * key (replacing any previous set), `affectedCacheKeys` returns a snapshot of
 * the cache keys that depend on an invalidated path, and `release` drops a
 * cache key from the index once its cached value is gone.
 */
export class DependencyIndex {
  private readonly cacheKeysByPath = new Map<string, Set<string>>();
  private readonly pathKeysByCacheKey = new Map<string, Set<string>>();

  register(cacheKey: string, fileNames: string[]): void {
    this.release(cacheKey);
    const pathKeys = new Set(fileNames.map(fileName => normalizePathKey(fileName)));
    this.pathKeysByCacheKey.set(cacheKey, pathKeys);
    for (const pathKey of pathKeys) {
      const cacheKeys = this.cacheKeysByPath.get(pathKey);
      if (cacheKeys) {
        cacheKeys.add(cacheKey);
      } else {
        this.cacheKeysByPath.set(pathKey, new Set([cacheKey]));
      }
    }
  }

  affectedCacheKeys(pathKey: string): string[] {
    const cacheKeys = this.cacheKeysByPath.get(pathKey);
    return cacheKeys ? [...cacheKeys] : [];
  }

  release(cacheKey: string): void {
    const pathKeys = this.pathKeysByCacheKey.get(cacheKey);
    if (!pathKeys) {
      return;
    }

    for (const pathKey of pathKeys) {
      const cacheKeys = this.cacheKeysByPath.get(pathKey);
      cacheKeys?.delete(cacheKey);
      if (cacheKeys?.size === 0) {
        this.cacheKeysByPath.delete(pathKey);
      }
    }
    this.pathKeysByCacheKey.delete(cacheKey);
  }

  clear(): void {
    this.cacheKeysByPath.clear();
    this.pathKeysByCacheKey.clear();
  }
}
