import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  createRsglBenchmarkScenarios,
  resolveRsglBenchmarkProfile
} from "./scenarios.mjs";

const csvColumns = [
  "scenario",
  "profile",
  "work_items",
  "input_bytes",
  "iterations",
  "outputs",
  "diagnostics",
  "source_mappings",
  "min_ms",
  "median_ms",
  "p95_ms"
];

export function runRsglBenchmarks(core, profileName = "default") {
  assertCoreApi(core);
  const profile = resolveRsglBenchmarkProfile(profileName);
  const scenarios = createRsglBenchmarkScenarios(core, profile);
  return scenarios.map(scenario => measureScenario(scenario, profile, profileName));
}

export function formatRsglBenchmarkCsv(rows) {
  const lines = [csvColumns.join(",")];
  for (const row of rows) {
    lines.push([
      row.scenario,
      row.profile,
      row.workItems,
      row.inputBytes,
      row.iterations,
      row.outputs,
      row.diagnostics,
      row.sourceMappings,
      row.minMs.toFixed(3),
      row.medianMs.toFixed(3),
      row.p95Ms.toFixed(3)
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function measureScenario(scenario, profile, profileName) {
  for (let index = 0; index < profile.warmupIterations; index++) {
    scenario.validate(scenario.run());
  }

  const durations = [];
  let stableMetrics;
  for (let index = 0; index < profile.measuredIterations; index++) {
    const startedAt = performance.now();
    const result = scenario.run();
    durations.push(performance.now() - startedAt);
    const metrics = scenario.validate(result);
    if (stableMetrics) {
      assert.deepEqual(metrics, stableMetrics, `${scenario.name} metrics changed between iterations`);
    } else {
      stableMetrics = metrics;
    }
  }

  const sorted = [...durations].sort((left, right) => left - right);
  return {
    scenario: scenario.name,
    profile: profileName,
    workItems: scenario.workItems,
    inputBytes: scenario.inputBytes,
    iterations: durations.length,
    ...stableMetrics,
    minMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95)
  };
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function assertCoreApi(core) {
  for (const name of ["parseRsgl", "bindRsglModule", "compileRsglModule"]) {
    if (typeof core[name] !== "function") {
      throw new Error(
        `Compiled RSGL core is missing '${name}'. Run npm run build -- --typecheck-only first.`
      );
    }
  }
}
