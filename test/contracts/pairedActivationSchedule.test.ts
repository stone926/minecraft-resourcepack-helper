import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ScheduleSlot {
  slot: number;
  cycle: number;
  cycleSlot: number;
  arm: "baseline" | "candidate";
  armIteration: number;
}

interface Schedule {
  algorithm: string;
  iterationsPerArm: number;
  cycleLength: number;
  cycleCount: number;
  slots: readonly ScheduleSlot[];
}

interface PairedScheduleModule {
  PAIRED_ACTIVATION_SCHEDULE_ALGORITHM: string;
  MAXIMUM_PAIRED_ACTIVATION_ITERATIONS_PER_ARM: number;
  createPairedActivationSchedule(iterationsPerArm: number): Schedule;
  validatePairedActivationSchedule(value: unknown): Schedule;
}

describe("paired activation schedule", () => {
  let scheduleModule: PairedScheduleModule;

  before(async () => {
    scheduleModule = await import(pathToFileURL(
      path.join(process.cwd(), "scripts", "activation-probe", "paired-schedule.mjs")
    ).href) as PairedScheduleModule;
  });

  it("builds the deterministic balanced ABBA/BAAB cycle", () => {
    const schedule = scheduleModule.createPairedActivationSchedule(4);
    assert.strictEqual(schedule.algorithm, "balanced-abba-baab-v1");
    assert.strictEqual(schedule.cycleLength, 8);
    assert.strictEqual(schedule.cycleCount, 1);
    assert.deepStrictEqual(
      schedule.slots.map(slot => slot.arm),
      ["baseline", "candidate", "candidate", "baseline", "candidate", "baseline", "baseline", "candidate"]
    );
    assert.deepStrictEqual(
      schedule.slots.filter(slot => slot.arm === "baseline").map(slot => slot.armIteration),
      [0, 1, 2, 3]
    );
    assert.deepStrictEqual(
      schedule.slots.filter(slot => slot.arm === "candidate").map(slot => slot.armIteration),
      [0, 1, 2, 3]
    );
    assert.strictEqual(scheduleModule.validatePairedActivationSchedule(schedule).slots.length, 8);
  });

  it("repeats the same canonical cycle without resetting arm iteration numbers", () => {
    const first = scheduleModule.createPairedActivationSchedule(8);
    const second = scheduleModule.createPairedActivationSchedule(8);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.slots.length, 16);
    assert.deepStrictEqual(first.slots.slice(8).map(slot => slot.armIteration), [4, 4, 5, 5, 6, 6, 7, 7]);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.slots));
  });

  it("rejects non-positive, fractional, unsafe, and non-multiple-of-four arm counts", () => {
    for (const invalid of [
      0,
      -4,
      1,
      2,
      6,
      4.5,
      1_004,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      assert.throws(
        () => scheduleModule.createPairedActivationSchedule(invalid),
        /positive safe integer divisible by 4/
      );
    }
    assert.strictEqual(scheduleModule.MAXIMUM_PAIRED_ACTIVATION_ITERATIONS_PER_ARM, 1_000);
    assert.strictEqual(scheduleModule.createPairedActivationSchedule(1_000).slots.length, 2_000);
  });

  it("rejects a schedule whose slots were reordered or rebound", () => {
    const schedule = scheduleModule.createPairedActivationSchedule(4);
    const forged = JSON.parse(JSON.stringify(schedule)) as Schedule;
    forged.slots[0].arm = "candidate";
    assert.throws(
      () => scheduleModule.validatePairedActivationSchedule(forged),
      /slot 0 does not match the canonical sequence/
    );
  });
});
