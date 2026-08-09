import * as assert from "node:assert";
import {
  ListenerSet,
  asDisposable,
  createKeyedDebouncer,
  createSingleFlight,
  createTrailingDebouncer,
  isLanguageDocumentLike,
  moduleExportWithFunction
} from "../../src";

describe("shared bundle utilities", () => {
  it("preserves synchronous Set listener mutation semantics", () => {
    const listeners = new ListenerSet<number>();
    const values: number[] = [];
    let second: { dispose(): void } = { dispose: () => undefined };
    listeners.add(value => {
      values.push(value);
      second.dispose();
    });
    second = listeners.add(value => values.push(value * 10));

    listeners.emit(2);
    assert.deepStrictEqual(values, [2]);
    assert.strictEqual(listeners.size, 1);
  });

  it("single-flights concurrent work and retries a rejection", async () => {
    const flight = createSingleFlight<number>();
    let calls = 0;
    const failure = Promise.reject<number>(new Error("first"));
    const first = flight.run(() => {
      calls += 1;
      return failure;
    });
    assert.strictEqual(flight.run(() => Promise.resolve(2)), first);
    await assert.rejects(first, /first/);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(await flight.run(async () => ++calls), 2);
  });

  it("reschedules and cancels trailing and keyed debounce work", async () => {
    const calls: string[] = [];
    const trailing = createTrailingDebouncer(5);
    trailing.schedule(() => calls.push("stale"));
    trailing.schedule(() => calls.push("trailing"));

    const keyed = createKeyedDebouncer(5);
    keyed.schedule("cancelled", () => calls.push("cancelled"));
    keyed.cancel("cancelled");
    keyed.schedule("cancel-all", () => calls.push("cancel-all"));
    keyed.cancelAll();
    keyed.schedule("kept", () => calls.push("keyed"));

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepStrictEqual(calls, ["trailing", "keyed"]);
    assert.strictEqual(trailing.pending, false);
  });

  it("shares disposal and awaited shutdown without duplicate reporting", async () => {
    let reject!: (error: Error) => void;
    const reported: unknown[] = [];
    const lifecycle = asDisposable(
      () => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }),
      error => reported.push(error)
    );
    lifecycle.dispose();
    const shutdown = lifecycle.shutdown();
    reject(new Error("expected"));
    await assert.rejects(shutdown, /expected/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(reported, []);
  });

  it("shares structural document and module-boundary helpers", () => {
    assert.strictEqual(
      isLanguageDocumentLike({ uriPath: "/PACK/FILE.RSGL" }, "rsgl", ".rsgl"),
      true
    );
    const direct = { create: () => undefined };
    assert.strictEqual(moduleExportWithFunction(direct, "create"), direct);
    assert.strictEqual(moduleExportWithFunction({ default: direct }, "create"), direct);
    assert.strictEqual(moduleExportWithFunction({}, "create"), undefined);
  });
});
