export interface TrailingDebouncer {
  schedule(callback: () => void, delayMs?: number): void;
  cancel(): void;
  readonly pending: boolean;
}

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
  schedule(key: string, callback: () => void, delayMs?: number): void;
  cancel(key: string): void;
  cancelAll(): void;
}

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
        byKey.delete(key);
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
