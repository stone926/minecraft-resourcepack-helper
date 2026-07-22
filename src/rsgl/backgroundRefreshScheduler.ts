export type BackgroundRefreshTimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundRefreshTimerHost {
  set(callback: () => void, delayMs: number): BackgroundRefreshTimerHandle;
  clear(handle: BackgroundRefreshTimerHandle): void;
}

export interface BackgroundRefreshSchedulerOptions<TKey> {
  /** Quiet period measured from the latest schedule, or from an active run completing. */
  readonly delayMs?: number;
  readonly run: (key: TKey) => void | Promise<void>;
  readonly onError?: (error: unknown, key: TKey) => void;
  readonly timerHost?: BackgroundRefreshTimerHost;
}

interface BackgroundRefreshState {
  timer?: BackgroundRefreshTimerHandle;
  timerGeneration: number;
  running: boolean;
  rerun: boolean;
  rerunDelayMs: number;
}

const defaultDelayMs = 250;

const defaultTimerHost: BackgroundRefreshTimerHost = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle)
};

/**
 * Coalesces asynchronous background work independently per key.
 *
 * Scheduling an idle key starts a trailing debounce timer. Scheduling a key
 * whose run is already active records one trailing rerun instead of starting
 * concurrent work; that rerun receives a fresh, complete quiet period after
 * the active run settles.
 */
export class BackgroundRefreshScheduler<TKey> {
  private readonly states = new Map<TKey, BackgroundRefreshState>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly delayMs: number;
  private readonly timerHost: BackgroundRefreshTimerHost;
  private disposed = false;

  public constructor(private readonly options: BackgroundRefreshSchedulerOptions<TKey>) {
    this.delayMs = normalizeDelay(options.delayMs, defaultDelayMs);
    this.timerHost = options.timerHost ?? defaultTimerHost;
  }

  public schedule(key: TKey, delayOverride?: number): void {
    if (this.disposed) {
      return;
    }
    const delayMs = normalizeDelay(delayOverride, this.delayMs);
    let state = this.states.get(key);
    if (!state) {
      state = {
        timerGeneration: 0,
        running: false,
        rerun: false,
        rerunDelayMs: this.delayMs
      };
      this.states.set(key, state);
    }

    if (state.running) {
      state.rerun = true;
      state.rerunDelayMs = delayMs;
      return;
    }
    this.armTimer(key, state, delayMs);
  }

  /** Cancels pending work for one key. An active run is allowed to settle. */
  public cancel(key: TKey): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    this.clearTimer(state);
    state.rerun = false;
    if (!state.running) {
      this.states.delete(key);
      this.notifyIdleIfNeeded();
    }
  }

  /** Cancels every timer and queued rerun without interrupting active runs. */
  public cancelAll(): void {
    for (const [key, state] of this.states) {
      this.clearTimer(state);
      state.rerun = false;
      if (!state.running) {
        this.states.delete(key);
      }
    }
    this.notifyIdleIfNeeded();
  }

  /** Resolves only after all pending timers, active runs, and queued reruns settle. */
  public whenIdle(): Promise<void> {
    if (this.states.size === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelAll();
  }

  private armTimer(key: TKey, state: BackgroundRefreshState, delayMs: number): void {
    this.clearTimer(state);
    const generation = ++state.timerGeneration;
    state.timer = this.timerHost.set(
      () => this.startRun(key, state!, generation),
      delayMs
    );
  }

  private startRun(key: TKey, state: BackgroundRefreshState, generation: number): void {
    if (
      this.disposed
      || this.states.get(key) !== state
      || state.timerGeneration !== generation
      || state.running
    ) {
      return;
    }
    state.timer = undefined;
    state.running = true;
    void this.executeRun(key, state);
  }

  private async executeRun(key: TKey, state: BackgroundRefreshState): Promise<void> {
    try {
      await this.options.run(key);
    } catch (error) {
      this.reportRunError(error, key);
    } finally {
      state.running = false;
      if (!this.disposed && state.rerun) {
        const delayMs = state.rerunDelayMs;
        state.rerun = false;
        this.armTimer(key, state, delayMs);
      } else {
        state.rerun = false;
        if (this.states.get(key) === state) {
          this.states.delete(key);
        }
        this.notifyIdleIfNeeded();
      }
    }
  }

  private clearTimer(state: BackgroundRefreshState): void {
    state.timerGeneration++;
    if (state.timer === undefined) {
      return;
    }
    this.timerHost.clear(state.timer);
    state.timer = undefined;
  }

  private reportRunError(error: unknown, key: TKey): void {
    try {
      this.options.onError?.(error, key);
    } catch {
      // Error reporting must not strand a key or suppress its queued rerun.
    }
  }

  private notifyIdleIfNeeded(): void {
    if (this.states.size > 0) {
      return;
    }
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}
