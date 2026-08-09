/** Dependency-free bounded least-recently-used cache shared across bundles. */
export class LruCache<Key, Value> {
  private readonly values = new Map<Key, Value>();

  public constructor(
    private readonly maximumSize: number,
    private readonly onEvict?: (key: Key, value: Value) => void
  ) {}

  public get(key: Key): Value | undefined {
    if (!this.values.has(key)) {
      return undefined;
    }
    const value = this.values.get(key) as Value;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  public set(key: Key, value: Value): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maximumSize) {
      const oldest = this.values.entries().next();
      if (oldest.done) {
        return;
      }
      const [oldestKey, oldestValue] = oldest.value;
      this.values.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestValue);
    }
  }

  public delete(key: Key): boolean {
    if (!this.values.has(key)) {
      return false;
    }
    const value = this.values.get(key) as Value;
    this.values.delete(key);
    this.onEvict?.(key, value);
    return true;
  }

  public clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.values) {
        this.onEvict(key, value);
      }
    }
    this.values.clear();
  }

  public peek(key: Key): Value | undefined {
    return this.values.get(key);
  }

  public entries(): IterableIterator<[Key, Value]> {
    return this.values.entries();
  }

  public get size(): number {
    return this.values.size;
  }
}
