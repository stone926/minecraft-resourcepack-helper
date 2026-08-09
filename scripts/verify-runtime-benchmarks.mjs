#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildBudgetConfiguration } from "./build-budget-config.mjs";
import { isMainModule } from "./lib/moduleIdentity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export function evaluateModelPreviewBenchmark(output, budgets) {
  const lines = nonEmptyLines(output);
  const metricsHeader = "fixture,first_ir_ms,hot_refresh_ms";
  const artifactHeader = "artifact,raw_bytes,gzip_bytes";
  if (lines[0] !== metricsHeader) {
    throw new Error(`Unexpected model-preview benchmark header: ${lines[0] ?? "<missing>"}`);
  }
  const artifactIndex = lines.indexOf(artifactHeader);
  if (artifactIndex < 2 || artifactIndex !== lines.length - 2) {
    throw new Error("Model-preview benchmark must emit one metrics table and one artifact row.");
  }
  const measured = {};
  for (const line of lines.slice(1, artifactIndex)) {
    const [fixture, firstIr, hotRefresh, ...extra] = line.split(",");
    if (!fixture || extra.length > 0) {
      throw new Error(`Malformed model-preview benchmark row: ${line}`);
    }
    measured[fixture] = Object.freeze({
      firstIr: requireNonNegativeNumber(firstIr, `${fixture}.firstIr`),
      hotRefresh: requireNonNegativeNumber(hotRefresh, `${fixture}.hotRefresh`)
    });
  }
  assertExactKeys(measured, budgets, "model-preview fixtures");
  for (const [fixture, limits] of Object.entries(budgets)) {
    assertWithinBudget(`${fixture} first IR`, measured[fixture].firstIr, limits.firstIr);
    assertWithinBudget(`${fixture} hot refresh`, measured[fixture].hotRefresh, limits.hotRefresh);
  }
  const [artifact, rawBytes, gzipBytes, ...extra] = lines.at(-1).split(",");
  if (artifact !== "model-preview-production" || extra.length > 0) {
    throw new Error("Model-preview benchmark emitted an unexpected artifact row.");
  }
  const raw = requirePositiveInteger(rawBytes, "model-preview raw bytes");
  const gzip = requirePositiveInteger(gzipBytes, "model-preview gzip bytes");
  if (gzip >= raw) {
    throw new Error(`Model-preview gzip bytes must be smaller than raw bytes: ${gzip} >= ${raw}.`);
  }
  return Object.freeze({ measured: Object.freeze(measured), artifact: { raw, gzip } });
}

export function evaluateRsglBenchmark(output, budgets) {
  const rows = nonEmptyLines(output).map(line => line.split(","));
  const expectedHeader = [
    "scenario", "profile", "work_items", "input_bytes", "iterations", "outputs",
    "diagnostics", "source_mappings", "min_ms", "median_ms", "p95_ms"
  ];
  if (JSON.stringify(rows[0]) !== JSON.stringify(expectedHeader)) {
    throw new Error("Unexpected RSGL benchmark CSV header.");
  }
  const measured = {};
  for (const row of rows.slice(1)) {
    if (row.length !== expectedHeader.length || row[1] !== "smoke") {
      throw new Error(`Malformed RSGL benchmark row: ${row.join(",")}`);
    }
    measured[row[0]] = requireNonNegativeNumber(row[10], `${row[0]}.p95`);
  }
  assertExactKeys(measured, budgets, "RSGL smoke scenarios");
  for (const [scenario, maximum] of Object.entries(budgets)) {
    assertWithinBudget(`${scenario} p95`, measured[scenario], maximum);
  }
  return Object.freeze(measured);
}

export function evaluateResourceUniverseBenchmark(report, budgets) {
  if (report?.schemaVersion !== 1 || report?.status !== "completed"
    || report?.command?.profile !== "smoke" || !Array.isArray(report.scenarios)) {
    throw new Error("Resource-universe benchmark report is not a completed smoke report.");
  }
  const scenarios = Object.fromEntries(report.scenarios.map(scenario => [scenario.id, scenario]));
  assertExactKeys(scenarios, budgets, "resource-universe smoke scenarios");
  const measured = {};
  for (const [scenarioId, metricBudgets] of Object.entries(budgets)) {
    const scenario = scenarios[scenarioId];
    if (scenario.status !== "measured" || !scenario.measurements) {
      throw new Error(`Resource-universe scenario '${scenarioId}' was not measured.`);
    }
    assertExactKeys(scenario.measurements, metricBudgets, `${scenarioId} metrics`);
    measured[scenarioId] = {};
    for (const [metric, maximum] of Object.entries(metricBudgets)) {
      const p95 = requireNonNegativeNumber(
        scenario.measurements[metric]?.p95,
        `${scenarioId}.${metric}.p95`
      );
      measured[scenarioId][metric] = p95;
      assertWithinBudget(`${scenarioId} ${metric} p95`, p95, maximum);
    }
    Object.freeze(measured[scenarioId]);
  }
  return Object.freeze(measured);
}

export function verifyRuntimeBenchmarks(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const run = options.runCommand ?? ((script, args) => runNodeScript(root, script, args));
  const budgets = (options.budgets ?? readBuildBudgetConfiguration()).runtimeBenchmarks;
  const measurementsRoot = path.join(root, "dist", "measurements");
  mkdirSync(measurementsRoot, { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(measurementsRoot, "runtime-budgets-"));
  try {
    const modelPreview = evaluateModelPreviewBenchmark(
      run("scripts/model-preview-benchmark.mjs", []),
      budgets.modelPreviewMilliseconds
    );
    const rsgl = evaluateRsglBenchmark(
      run("scripts/rsgl-benchmark.mjs", ["--smoke"]),
      budgets.rsglSmokeP95Milliseconds
    );
    const reportFile = path.join(temporaryRoot, "resource-universe.json");
    run("scripts/resource-universe-benchmark.mjs", ["--smoke", "--out", reportFile]);
    const resourceUniverse = evaluateResourceUniverseBenchmark(
      JSON.parse(readFileSync(reportFile, "utf8")),
      budgets.resourceUniverseSmokeP95Milliseconds
    );
    return Object.freeze({ modelPreview, rsgl, resourceUniverse });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runNodeScript(root, relativeScript, args) {
  const result = spawnSync(process.execPath, [path.join(root, relativeScript), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Runtime benchmark failed: ${relativeScript} ${args.join(" ")}`,
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  if (result.stderr) {
    throw new Error(`${relativeScript} wrote unexpected stderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function nonEmptyLines(output) {
  return String(output).trim().split(/\r?\n/).filter(Boolean);
}

function assertExactKeys(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} differ from configured budgets: measured [${actualKeys}], expected [${expectedKeys}].`
    );
  }
}

function requireNonNegativeNumber(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a finite non-negative number; got ${value}.`);
  }
  return number;
}

function requirePositiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}.`);
  }
  return number;
}

function assertWithinBudget(label, actual, maximum) {
  if (!Number.isFinite(maximum) || maximum <= 0) {
    throw new Error(`Missing positive runtime budget for ${label}.`);
  }
  if (actual > maximum) {
    throw new Error(`${label} exceeded its runtime budget: ${actual} > ${maximum}.`);
  }
  console.log(`${label}: ${actual.toFixed(3)}/${maximum} ms`);
}

if (isMainModule(import.meta.url)) {
  verifyRuntimeBenchmarks();
  console.log("Runtime benchmark budgets passed.");
}
