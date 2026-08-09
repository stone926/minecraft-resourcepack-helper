export interface SingleFlight<T> {
  /** Runs `loader` once; concurrent calls share the in-flight promise. */
  run(loader: () => Promise<T>): Promise<T>;
  /** Drops the in-flight promise, allowing a fresh run later. */
  clear(): void;
  readonly inFlight: boolean;
}

/** Shares one in-flight attempt and automatically permits retry after failure. */
export function createSingleFlight<T>(): SingleFlight<T> {
  let current: Promise<T> | undefined;
  return {
    get inFlight() {
      return current !== undefined;
    },
    run(loader) {
      if (current) {
        return current;
      }
      const attempt = loader();
      current = attempt;
      void attempt.catch(() => {
        if (current === attempt) {
          current = undefined;
        }
      });
      return attempt;
    },
    clear() {
      current = undefined;
    }
  };
}
