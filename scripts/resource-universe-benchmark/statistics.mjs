import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

export function measureSynchronous(action, iterations) {
  assertPositiveInteger(iterations, "measurement iterations");
  const durations = [];
  let result;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    result = action(index);
    durations.push(performance.now() - startedAt);
  }
  return Object.freeze({ result, distribution: createDistribution(durations) });
}

export async function measureAsynchronous(action, iterations) {
  assertPositiveInteger(iterations, "measurement iterations");
  const durations = [];
  let result;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    result = await action(index);
    durations.push(performance.now() - startedAt);
  }
  return Object.freeze({ result, distribution: createDistribution(durations) });
}

export function measureSynchronousBatches(values, batchSize, action, passes = 1) {
  assertPositiveInteger(batchSize, "query batch size");
  assertPositiveInteger(passes, "query passes");
  const durations = [];
  let operationCount = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let offset = 0; offset < values.length; offset += batchSize) {
      const batch = values.slice(offset, offset + batchSize);
      const startedAt = performance.now();
      for (const value of batch) {
        action(value);
        operationCount += 1;
      }
      durations.push(performance.now() - startedAt);
    }
  }
  return Object.freeze({
    operationCount,
    batchCount: durations.length,
    distribution: createDistribution(durations)
  });
}

export function createDistribution(values) {
  assert.ok(values.length > 0, "A distribution requires at least one sample.");
  assert.ok(values.every(Number.isFinite), "Distribution samples must be finite numbers.");
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return Object.freeze({
    samples: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length
  });
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
