import * as assert from "node:assert/strict";
import { ResourceRefreshCoordinator } from "../../services/resourceRefreshCoordinator";

describe("resource refresh coordinator", () => {
  it("invalidates shared caches before refreshing diagnostics and graph", () => {
    const calls: string[] = [];
    const coordinator = new ResourceRefreshCoordinator(
      { invalidateAll: () => calls.push("cache") },
      { refreshAll: () => calls.push("diagnostics") },
      { refresh: () => calls.push("graph") }
    );

    coordinator.refreshAll();

    assert.deepStrictEqual(calls, ["cache", "diagnostics", "graph"]);
  });
});
