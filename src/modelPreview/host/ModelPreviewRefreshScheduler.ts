interface PendingRefresh {
  unconditional: boolean;
  shouldRefresh: (() => boolean) | null;
}

interface RefreshTimerHost {
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

const defaultTimerHost: RefreshTimerHost = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle)
};

/** Coalesces preview refreshes without allowing an incomplete edit to hide a required refresh. */
export class ModelPreviewRefreshScheduler {
  private readonly pending = new Map<string, PendingRefresh>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly refresh: (reason: string) => void,
    private readonly delay = 180,
    private readonly timerHost: RefreshTimerHost = defaultTimerHost
  ) {}

  schedule(reason: string, shouldRefresh?: () => boolean): void {
    const existing = this.pending.get(reason);
    this.pending.set(reason, {
      unconditional: (existing?.unconditional ?? false) || shouldRefresh === undefined,
      shouldRefresh: shouldRefresh ?? existing?.shouldRefresh ?? null
    });

    if (this.timer) {
      this.timerHost.clear(this.timer);
    }
    this.timer = this.timerHost.set(() => this.flush(), this.delay);
  }

  dispose(): void {
    if (this.timer) {
      this.timerHost.clear(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private flush(): void {
    this.timer = null;
    const pendingRefreshes = [...this.pending];
    this.pending.clear();
    const eligibleReasons = pendingRefreshes
      .filter(([, pending]) => isEligible(pending))
      .map(([reason]) => reason);

    if (eligibleReasons.length === 0) {
      return;
    }
    this.refresh(eligibleReasons.length === 1 ? eligibleReasons[0] : "configuration");
  }
}

function isEligible(pending: PendingRefresh): boolean {
  if (pending.unconditional) {
    return true;
  }
  try {
    return pending.shouldRefresh?.() ?? false;
  } catch {
    return false;
  }
}
