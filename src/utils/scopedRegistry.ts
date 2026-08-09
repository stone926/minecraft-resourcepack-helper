export interface ScopedRegistration {
  dispose(): void;
}

interface RegistryEntry<V> {
  readonly token: symbol;
  readonly value: V;
}

/**
 * Small last-registration-wins registry for composition-time dependency
 * injection. Registrations may be disposed in any order without disturbing a
 * newer owner of the same key.
 */
export class ScopedRegistry<K, V> {
  private readonly entries = new Map<K, RegistryEntry<V>[]>();

  register(key: K, value: V): ScopedRegistration {
    const entry = { token: Symbol("scoped-registry"), value };
    const values = this.entries.get(key);
    if (values) {
      values.push(entry);
    } else {
      this.entries.set(key, [entry]);
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const current = this.entries.get(key);
        const index = current?.findIndex(candidate => candidate.token === entry.token) ?? -1;
        if (!current || index < 0) {
          return;
        }
        current.splice(index, 1);
        if (current.length === 0) {
          this.entries.delete(key);
        }
      }
    };
  }

  get(key: K): V | undefined {
    return this.entries.get(key)?.at(-1)?.value;
  }
}
