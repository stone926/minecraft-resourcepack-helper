export interface SingleFlight<T> {
  /** Runs `loader` once; concurrent calls share the in-flight promise. */
  run(loader: () => Promise<T>): Promise<T>;
  /** Drops the in-flight promise (e.g. on dispose), allowing a fresh run later. */
  clear(): void;
  readonly inFlight: boolean;
}

/**
 * Shares one in-flight asynchronous load and forgets it on failure, so the
 * next `run` retries. Disposed/rollback checks stay at each call site because
 * their semantics differ; this helper owns only the single-flight mechanics.
 */
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
