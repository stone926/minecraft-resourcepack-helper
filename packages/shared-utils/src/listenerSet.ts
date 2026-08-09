import type { Disposable } from "./disposable";

/** Small synchronous event primitive for layers that cannot depend on VS Code. */
export class ListenerSet<T> {
  private readonly listeners = new Set<(event: T) => void>();

  public add(listener: (event: T) => void): Disposable {
    this.listeners.add(listener);
    let active = true;
    return {
      dispose: () => {
        if (!active) {
          return;
        }
        active = false;
        this.listeners.delete(listener);
      }
    };
  }

  public emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public clear(): void {
    this.listeners.clear();
  }

  public get size(): number {
    return this.listeners.size;
  }
}
