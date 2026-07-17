import * as assert from "node:assert";
import { ResourceMutationTracker } from "../../services/resourceMutationTracker";

describe("resource mutation tracker", () => {
  it("matches exact paths while retaining a safe barrier for evicted history", () => {
    const tracker = new ResourceMutationTracker(2);
    const initial = tracker.currentGeneration();
    tracker.recordPath("pack/a.json");

    assert.strictEqual(tracker.hasAnyChangedSince(initial, ["pack/b.json"]), false);
    assert.strictEqual(tracker.hasAnyChangedSince(initial, ["pack/a.json"]), true);

    const beforeEviction = tracker.currentGeneration();
    tracker.recordPath("pack/b.json");
    tracker.recordPath("pack/c.json");
    assert.strictEqual(
      tracker.hasAnyChangedSince(beforeEviction, ["pack/unrelated.json"]),
      false,
      "evictions older than the snapshot do not affect it"
    );
    assert.strictEqual(
      tracker.hasAnyChangedSince(initial, ["pack/unrelated.json"]),
      true,
      "an evicted post-snapshot mutation must conservatively invalidate"
    );
  });

  it("uses a clearable global barrier for configuration and full invalidation", () => {
    const tracker = new ResourceMutationTracker(2);
    tracker.recordPath("pack/a.json");
    const beforeGlobal = tracker.currentGeneration();
    tracker.recordGlobal();

    assert.strictEqual(tracker.hasAnyChangedSince(beforeGlobal, ["pack/unrelated.json"]), true);
    assert.strictEqual(
      tracker.hasAnyChangedSince(tracker.currentGeneration(), ["pack/unrelated.json"]),
      false
    );
  });
});
