import * as assert from "node:assert/strict";
import { shouldRequestGeneratedSnapshot } from "../../services/generatedResourceRefreshPolicy";

describe("generated resource refresh policy", () => {
  it("requests only unknown or stale facts and breaks successful Tree replacement loops", () => {
    assert.strictEqual(shouldRequestGeneratedSnapshot(undefined), true);
    assert.strictEqual(shouldRequestGeneratedSnapshot({ status: "unavailable", reason: "notProbed" }), true);
    assert.strictEqual(shouldRequestGeneratedSnapshot({ status: "unavailable", reason: "stale" }), true);
    assert.strictEqual(shouldRequestGeneratedSnapshot({
      status: "authoritative",
      revision: "r1",
      coveredScope: { projectId: "project" }
    }), false);
    assert.strictEqual(shouldRequestGeneratedSnapshot({ status: "unavailable", reason: "loading" }), false);
    assert.strictEqual(shouldRequestGeneratedSnapshot({ status: "unavailable", reason: "lspFailed" }), false);
  });
});
