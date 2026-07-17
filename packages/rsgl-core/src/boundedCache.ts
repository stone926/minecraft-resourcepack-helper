/** Small dependency-free LRU used by long-lived core services. */
export class BoundedCache<Key, Value> {
  private readonly values = new Map<Key, Value>();

  public constructor(private readonly maximumSize: number) {}

  public get(key: Key): Value | undefined {
    const value = this.values.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  public set(key: Key, value: Value): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maximumSize) {
      const oldest = this.values.keys().next().value as Key | undefined;
      if (oldest === undefined) {
        return;
      }
      this.values.delete(oldest);
    }
  }

  public delete(key: Key): boolean {
    return this.values.delete(key);
  }

  public clear(): void {
    this.values.clear();
  }
}
