export class ResourceCacheMetrics {
  private readonly hits = new Map<string, number>();
  private readonly misses = new Map<string, number>();

  hit(cacheName: string): void {
    this.hits.set(cacheName, (this.hits.get(cacheName) ?? 0) + 1);
  }

  miss(cacheName: string): void {
    this.misses.set(cacheName, (this.misses.get(cacheName) ?? 0) + 1);
  }

  snapshot(): { hits: Record<string, number>; misses: Record<string, number> } {
    return {
      hits: Object.fromEntries(this.hits),
      misses: Object.fromEntries(this.misses)
    };
  }
}
