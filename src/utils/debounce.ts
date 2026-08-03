export interface TrailingDebouncer {
  /** Cancels any pending run and starts a fresh trailing timer. */
  schedule(callback: () => void, delayMs?: number): void;
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Cancel-and-reschedule trailing debounce shared by the main bundle's tree,
 * search-quickpick, and decoration refreshes. The lazy RSGL host keeps its
 * own richer per-key scheduler in `src/rsgl/backgroundRefreshScheduler.ts`
 * because the root-bundle build contract forbids importing it from main.
 */
export function createTrailingDebouncer(defaultDelayMs = 150): TrailingDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    get pending() {
      return timer !== null;
    },
    schedule(callback, delayMs = defaultDelayMs) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        callback();
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

export interface KeyedDebouncer {
  /** Cancels the key's pending run and starts a fresh trailing timer for it. */
  schedule(key: string, callback: () => void, delayMs?: number): void;
  cancel(key: string): void;
  cancelAll(): void;
}

/**
 * Per-key trailing debounce. This is the main-bundle counterpart of the lazy
 * host's `BackgroundRefreshScheduler` (per-key + rerun semantics), which the
 * root-bundle build contract forbids importing from main. Each key owns an
 * independent timer so canceling one document never affects another.
 */
export function createKeyedDebouncer(defaultDelayMs = 150): KeyedDebouncer {
  const byKey = new Map<string, TrailingDebouncer>();
  return {
    schedule(key, callback, delayMs = defaultDelayMs) {
      let debouncer = byKey.get(key);
      if (!debouncer) {
        debouncer = createTrailingDebouncer();
        byKey.set(key, debouncer);
      }
      debouncer.schedule(callback, delayMs);
    },
    cancel(key) {
      const debouncer = byKey.get(key);
      if (debouncer) {
        debouncer.cancel();
        if (!debouncer.pending) {
          byKey.delete(key);
        }
      }
    },
    cancelAll() {
      for (const debouncer of byKey.values()) {
        debouncer.cancel();
      }
      byKey.clear();
    }
  };
}
