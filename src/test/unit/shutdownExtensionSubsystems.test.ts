import * as assert from "node:assert";
import { shutdownExtensionSubsystems } from "../../registration/shutdownExtensionSubsystems";
import { asDisposable } from "../../utils/asyncShutdown";

describe("extension subsystem shutdown", () => {
  it("adapts async shutdown to an idempotent synchronous disposable", async () => {
    let calls = 0;
    let release!: () => void;
    const completed = new Promise<void>(resolve => {
      release = resolve;
    });
    const disposable = asDisposable(async () => {
      calls += 1;
      await completed;
    });

    disposable.dispose();
    disposable.dispose();
    assert.strictEqual(calls, 1);
    release();
    await completed;
  });

  it("single-flights awaited shutdown and synchronous disposal", async () => {
    let calls = 0;
    const expected = new Error("shared failure");
    const reported: unknown[] = [];
    const lifecycle = asDisposable(
      async () => {
        calls += 1;
        throw expected;
      },
      error => reported.push(error)
    );

    const shutdown = lifecycle.shutdown();
    lifecycle.dispose();
    lifecycle.dispose();
    await assert.rejects(shutdown, error => error === expected);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(reported, []);
  });

  it("does not report a disposal failure that becomes explicitly awaited", async () => {
    let reject!: (error: Error) => void;
    const failure = new Error("late failure");
    const reported: unknown[] = [];
    const lifecycle = asDisposable(
      () => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }),
      error => reported.push(error)
    );

    lifecycle.dispose();
    const shutdown = lifecycle.shutdown();
    reject(failure);
    await assert.rejects(shutdown, error => error === failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(reported, []);
  });

  it("reports rejected background shutdowns", async () => {
    const expected = new Error("shutdown");
    let reported: unknown;
    let report!: () => void;
    const didReport = new Promise<void>(resolve => {
      report = resolve;
    });
    const disposable = asDisposable(
      async () => { throw expected; },
      error => {
        reported = error;
        report();
      }
    );

    disposable.dispose();
    await didReport;
    assert.strictEqual(reported, expected);
  });

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
