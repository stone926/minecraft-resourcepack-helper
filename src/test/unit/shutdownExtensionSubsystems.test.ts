import * as assert from "node:assert";
import { shutdownExtensionSubsystems } from "../../registration/shutdownExtensionSubsystems";

describe("extension subsystem shutdown", () => {
  it("still shuts down RSGL when resource disposal fails", async () => {
    const calls: string[] = [];
    const resourceError = new Error("resource disposal");

    await assert.rejects(
      shutdownExtensionSubsystems(
        { dispose: () => { calls.push("resources"); throw resourceError; } },
        { shutdown: async () => { calls.push("rsgl"); } }
      ),
      error => error === resourceError
    );
    assert.deepStrictEqual(calls, ["resources", "rsgl"]);
  });

  it("aggregates independent shutdown failures", async () => {
    await assert.rejects(
      shutdownExtensionSubsystems(
        { dispose: () => { throw new Error("resources"); } },
        { shutdown: async () => { throw new Error("rsgl"); } }
      ),
      error => error instanceof AggregateError && error.errors.length === 2
    );
  });
});
