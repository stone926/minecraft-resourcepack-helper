export const PAIRED_ACTIVATION_SCHEDULE_ALGORITHM = "balanced-abba-baab-v1";
export const MAXIMUM_PAIRED_ACTIVATION_ITERATIONS_PER_ARM = 1_000;

const BALANCED_CYCLE = Object.freeze([
  "baseline",
  "candidate",
  "candidate",
  "baseline",
  "candidate",
  "baseline",
  "baseline",
  "candidate"
]);

export function createPairedActivationSchedule(iterationsPerArm) {
  assertIterationsPerArm(iterationsPerArm);
  const armIterations = { baseline: 0, candidate: 0 };
  const slots = [];
  const cycleCount = iterationsPerArm / 4;

  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    for (let cycleSlot = 0; cycleSlot < BALANCED_CYCLE.length; cycleSlot += 1) {
      const arm = BALANCED_CYCLE[cycleSlot];
      slots.push(Object.freeze({
        slot: slots.length,
        cycle,
        cycleSlot,
        arm,
        armIteration: armIterations[arm]
      }));
      armIterations[arm] += 1;
    }
  }

  return Object.freeze({
    algorithm: PAIRED_ACTIVATION_SCHEDULE_ALGORITHM,
    iterationsPerArm,
    cycleLength: BALANCED_CYCLE.length,
    cycleCount,
    slots: Object.freeze(slots)
  });
}

export function validatePairedActivationSchedule(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Paired activation schedule must be an object.");
  }
  if (value.algorithm !== PAIRED_ACTIVATION_SCHEDULE_ALGORITHM) {
    throw new Error(`Unknown paired activation schedule algorithm: ${String(value.algorithm)}`);
  }
  const expected = createPairedActivationSchedule(value.iterationsPerArm);
  if (value.cycleLength !== expected.cycleLength
    || value.cycleCount !== expected.cycleCount
    || !Array.isArray(value.slots) || value.slots.length !== expected.slots.length) {
    throw new Error("Paired activation schedule has an invalid slot count.");
  }
  for (let index = 0; index < expected.slots.length; index += 1) {
    const actualSlot = value.slots[index];
    const expectedSlot = expected.slots[index];
    if (!actualSlot || typeof actualSlot !== "object"
      || actualSlot.slot !== expectedSlot.slot
      || actualSlot.cycle !== expectedSlot.cycle
      || actualSlot.cycleSlot !== expectedSlot.cycleSlot
      || actualSlot.arm !== expectedSlot.arm
      || actualSlot.armIteration !== expectedSlot.armIteration) {
      throw new Error(`Paired activation schedule slot ${index} does not match the canonical sequence.`);
    }
  }
  return expected;
}

function assertIterationsPerArm(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value % 4 !== 0
    || value > MAXIMUM_PAIRED_ACTIVATION_ITERATIONS_PER_ARM) {
    throw new Error(
      `iterationsPerArm must be a positive safe integer divisible by 4 and no greater than ${MAXIMUM_PAIRED_ACTIVATION_ITERATIONS_PER_ARM}.`
    );
  }
}
