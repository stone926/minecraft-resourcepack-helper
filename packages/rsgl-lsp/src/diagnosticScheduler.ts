export interface DirtyDiagnosticSchedulerOptions<T> {
  readonly delayMs?: number;
  readonly run: (entry: T, generation: number) => void | Promise<void>;
  readonly onIdle?: () => void | Promise<void>;
  readonly yieldControl?: () => Promise<void>;
}

/**
 * Coalesces dirty document ids and yields before every expensive validation.
 * A newer generation requeues work that has not started, so stale batches do
 * not blindly validate every open document after a newer edit arrives.
 */
export class DirtyDiagnosticScheduler<T> {
  private readonly dirty = new Set<T>();
  private readonly delayMs: number;
  private readonly yieldControl: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeDrain: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;

  public constructor(private readonly options: DirtyDiagnosticSchedulerOptions<T>) {
    this.delayMs = Math.max(0, options.delayMs ?? 150);
    this.yieldControl = options.yieldControl ?? yieldToEventLoop;
  }

  public schedule(entries: Iterable<T>, delayMs = this.delayMs): void {
    if (this.disposed) {
      return;
    }
    let added = false;
    for (const entry of entries) {
      this.dirty.add(entry);
      added = true;
    }
    if (!added) {
      return;
    }
    this.generation++;
    if (!this.activeDrain) {
      this.scheduleTimer(delayMs);
    }
  }

  public drop(entry: T): void {
    this.dirty.delete(entry);
  }

  public async flush(): Promise<void> {
    this.clearTimer();
    await this.startDrain();
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
    this.clearTimer();
    this.dirty.clear();
  }

  private scheduleTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.startDrain();
    }, Math.max(0, delayMs));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private startDrain(): Promise<void> {
    if (this.activeDrain) {
      return this.activeDrain;
    }
    const drain = this.drain().finally(() => {
      if (this.activeDrain === drain) {
        this.activeDrain = null;
      }
      if (!this.disposed && this.dirty.size > 0) {
        this.scheduleTimer(0);
      }
    });
    this.activeDrain = drain;
    return drain;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.dirty.size > 0) {
      const batch = [...this.dirty];
      this.dirty.clear();
      const batchGeneration = this.generation;

      await this.yieldControl();
      if (this.disposed) {
        return;
      }
      if (batchGeneration !== this.generation) {
        this.requeue(batch);
        continue;
      }

      for (let index = 0; index < batch.length; index++) {
        await this.yieldControl();
        if (this.disposed) {
          return;
        }
        if (batchGeneration !== this.generation) {
          this.requeue(batch.slice(index));
          break;
        }
        await this.options.run(batch[index], batchGeneration);
      }
    }

    if (!this.disposed) {
      await this.options.onIdle?.();
    }
  }

  private requeue(entries: readonly T[]): void {
    for (const entry of entries) {
      this.dirty.add(entry);
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
