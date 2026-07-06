export class LruCache<K, V> {
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
