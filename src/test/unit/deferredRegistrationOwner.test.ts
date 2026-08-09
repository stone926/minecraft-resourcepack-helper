import * as assert from "node:assert/strict";
import { DeferredRegistrationOwner } from "../../registration/deferredRegistrationOwner";

describe("deferred registration owner", () => {
  it("installs immediately when a caller is already waiting on the surface", () => {
    let installs = 0;
    let schedules = 0;
    const owner = new DeferredRegistrationOwner(
      () => { installs += 1; },
      {
        schedule: () => { schedules += 1; return 1; },
        cancel: () => undefined
      },
      error => { throw error; }
    );

    owner.start(true);
    owner.start(true);

    assert.strictEqual(installs, 1);
    assert.strictEqual(schedules, 0);
    assert.strictEqual(owner.isInstalled, true);
  });

  it("defers once and cancels before installation", () => {
    let callback: (() => void) | undefined;
    let cancelled: number | undefined;
    let installs = 0;
    const owner = new DeferredRegistrationOwner(
      () => { installs += 1; },
      {
        schedule: value => { callback = value; return 7; },
        cancel: handle => { cancelled = handle; }
      },
      error => { throw error; }
    );

    owner.start(false);
    owner.start(false);
    owner.dispose();
    callback?.();

    assert.strictEqual(cancelled, 7);
    assert.strictEqual(installs, 0);
    assert.strictEqual(owner.isInstalled, false);
  });

  it("isolates a deferred installation failure", () => {
    let callback: (() => void) | undefined;
    const expected = new Error("expected registration failure");
    let observed: unknown;
    const owner = new DeferredRegistrationOwner(
      () => { throw expected; },
      {
        schedule: value => { callback = value; return 1; },
        cancel: () => undefined
      },
      error => { observed = error; }
    );

    owner.start(false);
    callback?.();

    assert.strictEqual(observed, expected);
    assert.strictEqual(owner.isInstalled, false);
  });

  it("cancels a pending turn and returns one synchronous installation", () => {
    let callback: (() => void) | undefined;
    let cancellations = 0;
    let installs = 0;
    const owner = new DeferredRegistrationOwner(
      () => ({ sequence: ++installs }),
      {
        schedule: value => { callback = value; return 3; },
        cancel: () => { cancellations += 1; }
      },
      error => { throw error; }
    );

    owner.start(false);
    const first = owner.ensureInstalled();
    const second = owner.ensureInstalled();
    callback?.();

    assert.deepStrictEqual(first, { sequence: 1 });
    assert.strictEqual(second, first);
    assert.strictEqual(installs, 1);
    assert.strictEqual(cancellations, 1);
  });

  it("rolls back a failed attempt and allows a later retry", () => {
    let attempts = 0;
    const owner = new DeferredRegistrationOwner(
      () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("first attempt");
        }
        return attempts;
      },
      { schedule: () => 1, cancel: () => undefined },
      error => { throw error; }
    );

    assert.throws(() => owner.ensureInstalled(), /first attempt/);
    assert.strictEqual(owner.isInstalled, false);
    assert.strictEqual(owner.ensureInstalled(), 2);
    assert.strictEqual(owner.isInstalled, true);
  });

  it("restores idle state when scheduling fails", () => {
    let schedules = 0;
    const owner = new DeferredRegistrationOwner(
      () => 9,
      {
        schedule: () => {
          schedules += 1;
          if (schedules === 1) {
            throw new Error("scheduler unavailable");
          }
          return 1;
        },
        cancel: () => undefined
      },
      error => { throw error; }
    );

    assert.throws(() => owner.start(false), /scheduler unavailable/);
    owner.start(false);
    assert.strictEqual(schedules, 2);
  });

  it("disposes an installed value exactly once", () => {
    const disposed: number[] = [];
    const owner = new DeferredRegistrationOwner(
      () => 11,
      { schedule: () => 1, cancel: () => undefined },
      error => { throw error; },
      value => { disposed.push(value); }
    );

    owner.ensureInstalled();
    owner.dispose();
    owner.dispose();

    assert.deepStrictEqual(disposed, [11]);
    assert.throws(() => owner.ensureInstalled(), /disposed/);
  });

  it("publishes before the installation hook and rolls back a failed hook", () => {
    const disposed: number[] = [];
    const owner = new DeferredRegistrationOwner<number, number>(
      () => 17,
      { schedule: () => 1, cancel: () => undefined },
      error => { throw error; },
      value => { disposed.push(value); },
      value => {
        assert.strictEqual(owner.ensureInstalled(), value);
        throw new Error("publication hook");
      }
    );

    assert.throws(() => owner.ensureInstalled(), /publication hook/);
    assert.strictEqual(owner.isInstalled, false);
    assert.deepStrictEqual(disposed, [17]);
  });
});
