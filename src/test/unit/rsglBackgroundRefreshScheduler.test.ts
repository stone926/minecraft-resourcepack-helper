import * as assert from "node:assert";
import {
  BackgroundRefreshScheduler,
  type BackgroundRefreshTimerHandle,
  type BackgroundRefreshTimerHost
} from "../../rsgl/backgroundRefreshScheduler";

describe("RSGL background refresh scheduler", () => {
  it("debounces each key independently and honors the latest delay override", async () => {
    const timer = new FakeTimerHost();
    const runs: string[] = [];
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 100,
      run: key => { runs.push(key); },
      timerHost: timer
    });

    scheduler.schedule("alpha");
    timer.advanceBy(60);
    scheduler.schedule("alpha");
    scheduler.schedule("beta", 20);

    timer.advanceBy(20);
    await settleAsyncWork();
    assert.deepStrictEqual(runs, ["beta"]);

    timer.advanceBy(79);
    assert.deepStrictEqual(runs, ["beta"]);
    timer.advanceBy(1);
    await scheduler.whenIdle();
    assert.deepStrictEqual(runs, ["beta", "alpha"]);
  });

  it("queues one non-concurrent rerun after a full delay from active completion", async () => {
    const timer = new FakeTimerHost();
    const firstRun = deferred<void>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 10,
      run: async () => {
        calls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) {
          await firstRun.promise;
        }
        active--;
      },
      timerHost: timer
    });

    scheduler.schedule("project");
    timer.advanceBy(10);
    assert.strictEqual(calls, 1);

    scheduler.schedule("project", 20);
    scheduler.schedule("project", 30);
    timer.advanceBy(100);
    assert.strictEqual(calls, 1, "an active key must never run concurrently");

    firstRun.resolve();
    await settleAsyncWork();
    timer.advanceBy(29);
    assert.strictEqual(calls, 1, "the rerun delay starts after active completion");
    timer.advanceBy(1);
    await scheduler.whenIdle();

    assert.strictEqual(calls, 2);
    assert.strictEqual(maximumActive, 1);
  });

  it("keeps whenIdle pending across timers, active work, and a queued rerun", async () => {
    const timer = new FakeTimerHost();
    const firstRun = deferred<void>();
    let calls = 0;
    let idle = false;
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 25,
      run: async () => {
        calls++;
        if (calls === 1) {
          await firstRun.promise;
        }
      },
      timerHost: timer
    });

    scheduler.schedule("project");
    const idlePromise = scheduler.whenIdle().then(() => { idle = true; });
    await settleAsyncWork();
    assert.strictEqual(idle, false);

    timer.advanceBy(25);
    scheduler.schedule("project");
    firstRun.resolve();
    await settleAsyncWork();
    assert.strictEqual(idle, false);

    timer.advanceBy(24);
    assert.strictEqual(idle, false);
    timer.advanceBy(1);
    await idlePromise;
    assert.strictEqual(calls, 2);
    assert.strictEqual(idle, true);
  });

  it("cancel removes a pending timer and suppresses an active key's queued rerun", async () => {
    const timer = new FakeTimerHost();
    const activeRun = deferred<void>();
    const runs: string[] = [];
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 10,
      run: async key => {
        runs.push(key);
        if (key === "active") {
          await activeRun.promise;
        }
      },
      timerHost: timer
    });

    scheduler.schedule("pending");
    scheduler.cancel("pending");
    scheduler.schedule("active");
    timer.advanceBy(10);
    scheduler.schedule("active");
    scheduler.cancel("active");
    timer.advanceBy(100);
    assert.deepStrictEqual(runs, ["active"]);

    let idle = false;
    const idlePromise = scheduler.whenIdle().then(() => { idle = true; });
    await settleAsyncWork();
    assert.strictEqual(idle, false, "cancel does not pretend an active run has stopped");
    activeRun.resolve();
    await idlePromise;
    timer.advanceBy(100);
    assert.deepStrictEqual(runs, ["active"]);
  });

  it("cancelAll clears pending keys while allowing later schedules", async () => {
    const timer = new FakeTimerHost();
    const runs: string[] = [];
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 10,
      run: key => { runs.push(key); },
      timerHost: timer
    });

    scheduler.schedule("first");
    scheduler.schedule("second");
    scheduler.cancelAll();
    await scheduler.whenIdle();
    timer.advanceBy(20);
    assert.deepStrictEqual(runs, []);

    scheduler.schedule("later");
    timer.advanceBy(10);
    await scheduler.whenIdle();
    assert.deepStrictEqual(runs, ["later"]);
  });

  it("dispose clears pending work, rejects later schedules, and still awaits an active run", async () => {
    const timer = new FakeTimerHost();
    const activeRun = deferred<void>();
    const runs: string[] = [];
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 10,
      run: async key => {
        runs.push(key);
        if (key === "active") {
          await activeRun.promise;
        }
      },
      timerHost: timer
    });

    scheduler.schedule("active");
    timer.advanceBy(10);
    scheduler.schedule("pending");
    scheduler.dispose();
    scheduler.schedule("ignored");
    timer.advanceBy(100);
    assert.deepStrictEqual(runs, ["active"]);

    let idle = false;
    const idlePromise = scheduler.whenIdle().then(() => { idle = true; });
    await settleAsyncWork();
    assert.strictEqual(idle, false);
    activeRun.resolve();
    await idlePromise;
    assert.strictEqual(idle, true);
  });

  it("reports run failures and preserves a rerun scheduled by a throwing error handler", async () => {
    const timer = new FakeTimerHost();
    const errors: Array<{ error: unknown; key: string }> = [];
    let calls = 0;
    const scheduler = new BackgroundRefreshScheduler<string>({
      delayMs: 5,
      run: () => {
        calls++;
        if (calls === 1) {
          throw new Error("refresh failed");
        }
      },
      onError: (error, key) => {
        errors.push({ error, key });
        scheduler.schedule(key, 15);
        throw new Error("logging failed");
      },
      timerHost: timer
    });

    scheduler.schedule("project");
    timer.advanceBy(5);
    await settleAsyncWork();
    assert.strictEqual(calls, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].key, "project");
    assert.match(String(errors[0].error), /refresh failed/);

    timer.advanceBy(14);
    assert.strictEqual(calls, 1);
    timer.advanceBy(1);
    await scheduler.whenIdle();
    assert.strictEqual(calls, 2);
  });
});

class FakeTimerHost implements BackgroundRefreshTimerHost {
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
  private now = 0;
  private nextHandle = 1;

  public set(callback: () => void, delayMs: number): BackgroundRefreshTimerHandle {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.now + delayMs, callback });
    return handle as unknown as BackgroundRefreshTimerHandle;
  }

  public clear(handle: BackgroundRefreshTimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  public advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.now = timer.dueAt;
      timer.callback();
    }
    this.now = target;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
