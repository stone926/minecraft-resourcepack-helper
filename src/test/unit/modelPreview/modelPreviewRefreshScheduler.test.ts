import * as assert from "node:assert/strict";
import { ModelPreviewRefreshScheduler } from "../../../modelPreview/host/ModelPreviewRefreshScheduler";

describe("model preview refresh scheduler", () => {
  it("does not let an incomplete edit suppress an already required refresh", () => {
    const reasons: string[] = [];
    const timer = new FakeTimerHost();
    const scheduler = new ModelPreviewRefreshScheduler(reason => reasons.push(reason), 180, timer);

    scheduler.schedule("configuration");
    scheduler.schedule("edited.json", () => false);
    timer.flush();

    assert.deepStrictEqual(reasons, ["configuration"]);
  });

  it("preserves an unconditional refresh when the same path later has an incomplete edit", () => {
    const reasons: string[] = [];
    const timer = new FakeTimerHost();
    const scheduler = new ModelPreviewRefreshScheduler(reason => reasons.push(reason), 180, timer);

    scheduler.schedule("edited.json");
    scheduler.schedule("edited.json", () => false);
    timer.flush();

    assert.deepStrictEqual(reasons, ["edited.json"]);
  });

  it("evaluates conditional edits only after the debounce interval", () => {
    const reasons: string[] = [];
    const timer = new FakeTimerHost();
    let complete = false;
    const scheduler = new ModelPreviewRefreshScheduler(reason => reasons.push(reason), 180, timer);

    scheduler.schedule("edited.json", () => complete);
    complete = true;
    timer.flush();

    assert.deepStrictEqual(reasons, ["edited.json"]);
  });

  it("uses one full invalidation when multiple dependencies change together", () => {
    const reasons: string[] = [];
    const timer = new FakeTimerHost();
    const scheduler = new ModelPreviewRefreshScheduler(reason => reasons.push(reason), 180, timer);

    scheduler.schedule("first.png");
    scheduler.schedule("second.png");
    timer.flush();

    assert.deepStrictEqual(reasons, ["configuration"]);
  });

  it("does not let a throwing edit predicate suppress a required refresh", () => {
    const reasons: string[] = [];
    const timer = new FakeTimerHost();
    const scheduler = new ModelPreviewRefreshScheduler(reason => reasons.push(reason), 180, timer);

    scheduler.schedule("configuration");
    scheduler.schedule("closed.json", () => {
      throw new Error("document is closed");
    });
    timer.flush();

    assert.deepStrictEqual(reasons, ["configuration"]);
  });
});

class FakeTimerHost {
  private callback: (() => void) | null = null;

  set(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    void delay;
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clear(handle: ReturnType<typeof setTimeout>): void {
    void handle;
    this.callback = null;
  }

  flush(): void {
    const callback = this.callback;
    this.callback = null;
    assert.ok(callback, "expected a pending refresh timer");
    callback();
  }
}
