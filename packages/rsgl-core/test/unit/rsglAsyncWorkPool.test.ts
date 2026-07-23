import * as assert from "node:assert";
import { mapWithConcurrency } from "../../src/asyncWorkPool";

describe("RSGL async work pool", () => {
  it("bounds concurrency and preserves input result order", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const started = Array.from({ length: 6 }, () => deferred<void>());
    let active = 0;
    let maximumActive = 0;
    const resultPromise = mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      2,
      async value => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        started[value].resolve();
        await gates[value].promise;
        active--;
        return `result-${value}`;
      }
    );

    await Promise.all([started[0].promise, started[1].promise]);
    assert.strictEqual(maximumActive, 2);
    gates[1].resolve();
    await started[2].promise;
    gates[2].resolve();
    await started[3].promise;
    gates[0].resolve();
    await started[4].promise;
    gates[4].resolve();
    await started[5].promise;
    gates[3].resolve();
    gates[5].resolve();

    assert.deepStrictEqual(await resultPromise, [
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5"
    ]);
    assert.strictEqual(maximumActive, 2);
  });

  it("stops scheduling after a failure and waits for in-flight work", async () => {
    const fail = deferred<void>();
    const finishInFlight = deferred<void>();
    const failureReached = deferred<void>();
    const started: number[] = [];
    let inFlightFinished = false;
    let poolSettled = false;
    const resultPromise = mapWithConcurrency(
      [0, 1, 2, 3],
      2,
      async value => {
        started.push(value);
        if (value === 0) {
          await fail.promise;
          failureReached.resolve();
          throw new Error("expected failure");
        }
        await finishInFlight.promise;
        inFlightFinished = true;
        return value;
      }
    );
    void resultPromise.then(
      () => { poolSettled = true; },
      () => { poolSettled = true; }
    );

    assert.deepStrictEqual(started, [0, 1]);
    fail.resolve();
    await failureReached.promise;
    await Promise.resolve();
    assert.deepStrictEqual(started, [0, 1]);
    assert.strictEqual(poolSettled, false);

    finishInFlight.resolve();
    await assert.rejects(resultPromise, /expected failure/);
    assert.strictEqual(inFlightFinished, true);
    assert.deepStrictEqual(started, [0, 1]);
  });

  it("reports the lowest-index in-flight failure deterministically", async () => {
    const failFirstCompletion = deferred<void>();
    const failLowestIndex = deferred<void>();
    const finishMiddle = deferred<void>();
    const resultPromise = mapWithConcurrency(
      [0, 1, 2],
      3,
      async value => {
        if (value === 0) {
          await failLowestIndex.promise;
          throw new Error("lowest input failure");
        }
        if (value === 1) {
          await finishMiddle.promise;
          return value;
        }
        await failFirstCompletion.promise;
        throw new Error("first completion failure");
      }
    );

    failFirstCompletion.resolve();
    await Promise.resolve();
    failLowestIndex.resolve();
    finishMiddle.resolve();

    await assert.rejects(resultPromise, /lowest input failure/);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
