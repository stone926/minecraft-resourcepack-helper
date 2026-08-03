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
