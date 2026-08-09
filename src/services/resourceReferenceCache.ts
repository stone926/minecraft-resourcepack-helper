import { normalizePathKey } from "../../packages/mc-assets/src";
import type { ResourceReference } from "../utils/resourceReferences/types";
import type { ResourceReferenceCacheDescriptor } from "../utils/resourceReferences/host";
import { DependencyIndex } from "./dependencyIndex";
import { LruCache } from "./lruCache";
import type { CacheMetricsHost } from "./resourceCacheTypes";

interface CachedResourceReferences extends ResourceReferenceCacheDescriptor {
  readonly references: ResourceReference[];
}

export class ResourceReferenceCache {
  private readonly dependencies = new DependencyIndex();
  private readonly values = new LruCache<string, CachedResourceReferences>(
    2048,
    key => this.dependencies.release(key)
  );

  constructor(private readonly metrics: CacheMetricsHost) {}

  get(descriptor: ResourceReferenceCacheDescriptor): ResourceReference[] | null {
    const cached = this.values.get(descriptor.key);
    if (
      !cached
      || cached.fileName !== descriptor.fileName
      || cached.documentKind !== descriptor.documentKind
      || cached.version !== descriptor.version
    ) {
      this.metrics.miss("resourceReferences");
      return null;
    }
    this.metrics.hit("resourceReferences");
    return cached.references;
  }

  set(
    descriptor: ResourceReferenceCacheDescriptor,
    references: ResourceReference[]
  ): void {
    this.dependencies.register(descriptor.key, [descriptor.fileName]);
    this.values.set(descriptor.key, { ...descriptor, references });
  }

  invalidatePath(fileName: string): void {
    for (const key of this.dependencies.affectedCacheKeys(normalizePathKey(fileName))) {
      this.values.delete(key);
    }
  }

  invalidateAll(): void {
    this.values.clear();
    this.dependencies.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
