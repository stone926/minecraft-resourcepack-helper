#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildBudgetConfiguration } from "./build-budget-config.mjs";
import { validateActivationProbeSample } from "./activation-probe/schema.mjs";
import { readVsixArchiveMetrics } from "./vsix-archive-metrics.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");

export const defaultJsonOnlyActivationBudgetInputs = Object.freeze({
  baseline: "dist/measurements/json-only-activation.baseline.extension-host.json",
  candidate: "dist/measurements/json-only-activation.combined-production.extension-host.json",
  output: "dist/measurements/json-only-activation-budget.json"
});

export function parseJsonOnlyActivationBudgetArguments(args) {
  const values = new Map();
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      if (help) {
        throw new Error("--help may only be specified once.");
      }
      help = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (!["--baseline", "--candidate", "--out"].includes(flag)) {
      throw new Error(`Unknown JSON-only activation budget argument: ${argument}`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} may only be specified once.`);
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing path after ${flag}.`);
    }
    values.set(flag, value);
    if (equals < 0) {
      index += 1;
    }
  }
  const result = Object.freeze({
    help,
    baselineFile: path.resolve(repositoryRoot, values.get("--baseline")
      ?? defaultJsonOnlyActivationBudgetInputs.baseline),
    candidateFile: path.resolve(repositoryRoot, values.get("--candidate")
      ?? defaultJsonOnlyActivationBudgetInputs.candidate),
    outputFile: path.resolve(repositoryRoot, values.get("--out")
      ?? defaultJsonOnlyActivationBudgetInputs.output)
  });
  if (!help) {
    const identities = [result.baselineFile, result.candidateFile, result.outputFile]
      .map(pathIdentity);
    if (new Set(identities).size !== identities.length) {
      throw new Error("baseline, candidate, and output paths must be distinct.");
    }
  }
  return result;
}

export function compareJsonOnlyActivationReports(baseline, candidate, budget) {
  const normalizedBaseline = validateActivationReport(baseline, "baseline", budget, false);
  const normalizedCandidate = validateActivationReport(candidate, "candidate", budget, true);
  const activationRegressionMilliseconds =
    normalizedCandidate.activationP95Milliseconds - normalizedBaseline.activationP95Milliseconds;
  const activationAllowanceMilliseconds = Math.max(
    budget.maximumAbsoluteP95RegressionMilliseconds,
    normalizedBaseline.activationP95Milliseconds * budget.maximumRelativeP95RegressionRatio
  );
  const steadyRssP95DeltaBytes =
    normalizedCandidate.steadyRssP95Bytes - normalizedBaseline.steadyRssP95Bytes;
  if (JSON.stringify(normalizedBaseline.extensionHostEnvironment)
    !== JSON.stringify(normalizedCandidate.extensionHostEnvironment)) {
    throw new Error("baseline and candidate must use the same VS Code Extension Host runtime.");
  }
  if (JSON.stringify(normalizedBaseline.measurementMachine)
    !== JSON.stringify(normalizedCandidate.measurementMachine)) {
    throw new Error("baseline and candidate must be measured on the same machine class.");
  }
  if (normalizedBaseline.artifactSha256 === normalizedCandidate.artifactSha256) {
    throw new Error("baseline and candidate must identify different VSIX artifacts.");
  }
  const gates = Object.freeze({
    activationP95WithinBudget:
      activationRegressionMilliseconds <= activationAllowanceMilliseconds,
    steadyRssP95WithinBudget:
      steadyRssP95DeltaBytes <= budget.maximumSteadyRssP95DeltaBytes,
    candidateHardConditionsPassed: normalizedCandidate.hardConditionsPassed
  });
  return Object.freeze({
    baseline: normalizedBaseline,
    candidate: normalizedCandidate,
    budget: Object.freeze({ ...budget }),
    comparison: Object.freeze({
      activationRegressionMilliseconds,
      activationAllowanceMilliseconds,
      steadyRssP95DeltaBytes
    }),
    gates,
    passed: Object.values(gates).every(Boolean)
  });
}

export async function verifyJsonOnlyActivationBudget(options) {
  const baseline = readJsonReport(options.baselineFile, "baseline");
  const candidate = readJsonReport(options.candidateFile, "candidate");
  const budget = readBuildBudgetConfiguration().jsonOnlyExtensionHost;
  const artifacts = Object.freeze({
    baseline: await verifyMeasuredVsix(baseline.value, "baseline", false),
    candidate: await verifyMeasuredVsix(candidate.value, "candidate", true)
  });
  const result = compareJsonOnlyActivationReports(baseline.value, candidate.value, budget);
  const report = Object.freeze({
    schemaVersion: 1,
    measurement: "json-only-extension-host-release-budget",
    generatedAt: new Date().toISOString(),
    inputs: Object.freeze({
      baseline: describeInput(options.baselineFile, baseline.bytes),
      candidate: describeInput(options.candidateFile, candidate.bytes)
    }),
    artifacts,
    ...result
  });
  mkdirSync(path.dirname(options.outputFile), { recursive: true });
  writeFileSync(options.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return Object.freeze({ report, outputFile: options.outputFile });
}

function validateActivationReport(report, label, budget, requireCombinedVsix) {
  if (!report || typeof report !== "object"
    || report.schemaVersion !== 1
    || report.measurement !== "json-only-activation") {
    throw new Error(`${label} is not a supported JSON-only activation report.`);
  }
  if (report.scope?.adapter !== "extension-host" || report.scope?.isExtensionHost !== true) {
    throw new Error(`${label} must be measured in a real VS Code Extension Host.`);
  }
  if (requireCombinedVsix && (report.scope?.isCombinedVsix !== true
    || report.scope?.artifactKind !== "combined-vsix")) {
    throw new Error("candidate must be measured from the combined production VSIX.");
  }
  if (!requireCombinedVsix && report.scope?.artifactKind !== "vsix") {
    throw new Error("baseline must be measured from an installable VSIX, not a development directory.");
  }
  if (report.valid !== true || report.summary?.failedSamples !== 0) {
    throw new Error(`${label} contains failed or invalid activation samples.`);
  }
  const successfulSamples = requireNonNegativeInteger(
    report.summary?.successfulSamples,
    `${label}.summary.successfulSamples`
  );
  const requestedIterations = requireNonNegativeInteger(
    report.input?.iterations,
    `${label}.input.iterations`
  );
  if (successfulSamples < budget.minimumIterations
    || requestedIterations < budget.minimumIterations) {
    throw new Error(
      `${label} requires at least ${budget.minimumIterations} successful fresh Extension Host samples.`
    );
  }
  const settleMilliseconds = requireNonNegativeInteger(
    report.input?.settleMilliseconds,
    `${label}.input.settleMilliseconds`
  );
  if (settleMilliseconds < budget.minimumSteadyStateSettleMilliseconds) {
    throw new Error(
      `${label} steady RSS requires at least ${budget.minimumSteadyStateSettleMilliseconds} ms settling time.`
    );
  }
  const rawSamples = validateRawSamples(
    report.samples,
    label,
    requestedIterations,
    successfulSamples
  );
  const activationP95Milliseconds = requireFiniteMetric(
    report.summary?.activationMilliseconds?.p95,
    `${label}.summary.activationMilliseconds.p95`
  );
  const steadyRssP95Bytes = requireFiniteMetric(
    report.summary?.steadyRssBytes?.p95,
    `${label}.summary.steadyRssBytes.p95`
  );
  assertMetricMatches(
    activationP95Milliseconds,
    percentile95(rawSamples.map(sample => sample.activationMilliseconds)),
    `${label}.summary.activationMilliseconds.p95`
  );
  assertMetricMatches(
    steadyRssP95Bytes,
    percentile95(rawSamples.map(sample => sample.steadyRssBytes)),
    `${label}.summary.steadyRssBytes.p95`
  );
  validateHardConditions(report.hardConditions, rawSamples, label);
  const hardConditionsPassed = report.hardConditions?.passed === true;
  if (!hardConditionsPassed) {
    throw new Error(`${label} does not satisfy the zero-module/process/scan hard conditions.`);
  }
  const artifactSha256 = report.input?.artifactSha256;
  if (typeof artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw new Error(`${label}.input.artifactSha256 must identify the measured artifact.`);
  }
  const artifactBytes = requirePositiveInteger(
    report.input?.artifactBytes,
    `${label}.input.artifactBytes`
  );
  const extensionHostEnvironment = validateExtensionHostEnvironment(
    report.environment?.extensionHost,
    rawSamples,
    label
  );
  const measurementMachine = validateMeasurementMachine(report.environment, label);
  return Object.freeze({
    artifact: report.input?.artifact ?? null,
    artifactBytes,
    artifactSha256,
    artifactKind: report.scope?.artifactKind ?? null,
    successfulSamples,
    activationP95Milliseconds,
    steadyRssP95Bytes,
    hardConditionsPassed,
    extensionHostEnvironment,
    measurementMachine
  });
}

const requiredExtensionHostHooks = Object.freeze([
  "Module._load",
  "child_process.spawn",
  "child_process.spawnSync",
  "child_process.fork",
  "child_process.exec",
  "child_process.execSync",
  "child_process.execFile",
  "child_process.execFileSync",
  "worker_threads.Worker",
  "vscode.workspace.findFiles",
  "vscode.workspace.fs.readDirectory",
  "vscode.workspace.createFileSystemWatcher"
]);

function validateRawSamples(samples, label, requestedIterations, successfulSamples) {
  if (!Array.isArray(samples) || samples.length !== requestedIterations
    || successfulSamples !== requestedIterations) {
    throw new Error(`${label} must contain every requested successful raw sample.`);
  }
  const iterations = new Set();
  const pids = new Set();
  for (const sample of samples) {
    validateActivationProbeSample(sample, "extension-host");
    if (sample.status !== "ok") {
      throw new Error(`${label} contains a failed raw sample.`);
    }
    iterations.add(sample.iteration);
    pids.add(sample.extensionHost.pid);
    const hooks = new Set(sample.installedHooks);
    const missingHooks = requiredExtensionHostHooks.filter(hook => !hooks.has(hook));
    if (missingHooks.length > 0) {
      throw new Error(`${label} sample ${sample.iteration} lacks instrumentation: ${missingHooks.join(", ")}.`);
    }
    if (sample.instrumentationWarnings.length > 0) {
      throw new Error(`${label} sample ${sample.iteration} contains instrumentation warnings.`);
    }
  }
  if (iterations.size !== requestedIterations
    || [...iterations].some(iteration => iteration >= requestedIterations)) {
    throw new Error(`${label} raw samples must cover each iteration exactly once.`);
  }
  if (pids.size !== requestedIterations) {
    throw new Error(`${label} must use a distinct fresh Extension Host process for every sample.`);
  }
  return samples;
}

function validateHardConditions(hardConditions, samples, label) {
  const counts = {
    rsglModuleLoads: sum(samples, sample => sample.moduleLoads.filter(event => event.rsgl).length),
    rsglProcessSpawnAttempts: sum(samples, sample => sample.processSpawns.filter(event => event.rsgl).length),
    rsglWorkerSpawnAttempts: sum(samples, sample => sample.workerSpawns.filter(event => event.rsgl).length),
    extensionOwnedNonRsglProcessSpawns: sum(samples, sample =>
      sample.processSpawns.filter(event => event.extensionOwned && !event.rsgl).length),
    hostProcessSpawnNoise: sum(samples, sample =>
      sample.processSpawns.filter(event => !event.extensionOwned && !event.rsgl).length),
    rsglFilesystemWalks: sum(samples, sample => sample.filesystemWalks.filter(event => event.rsgl).length),
    rsglWatcherRegistrations: sum(samples, sample => sample.watcherRegistrations.filter(event => event.rsgl).length),
    instrumentationWarnings: sum(samples, sample => sample.instrumentationWarnings.length)
  };
  const conditions = {
    rsglModuleLoadsZero: counts.rsglModuleLoads === 0,
    rsglProcessSpawnAttemptsZero: counts.rsglProcessSpawnAttempts === 0,
    rsglWorkerSpawnAttemptsZero: counts.rsglWorkerSpawnAttempts === 0,
    rsglFilesystemWalksZero: counts.rsglFilesystemWalks === 0,
    rsglWatcherRegistrationsZero: counts.rsglWatcherRegistrations === 0,
    instrumentationWarningsZero: counts.instrumentationWarnings === 0
  };
  if (!hardConditions || hardConditions.passed !== true
    || Object.entries(conditions).some(([name, value]) => hardConditions[name] !== value)
    || Object.entries(counts).some(([name, value]) => hardConditions.counts?.[name] !== value)
    || !Object.values(conditions).every(Boolean)) {
    throw new Error(`${label} does not satisfy the recomputed zero-module/process/scan/watcher hard conditions.`);
  }
}

function validateExtensionHostEnvironment(environment, samples, label) {
  const first = samples[0].extensionHost;
  const normalized = Object.freeze({
    node: first.node,
    platform: first.platform,
    arch: first.arch,
    vscodeVersion: first.vscodeVersion
  });
  if (samples.some(sample => JSON.stringify({
    node: sample.extensionHost.node,
    platform: sample.extensionHost.platform,
    arch: sample.extensionHost.arch,
    vscodeVersion: sample.extensionHost.vscodeVersion
  }) !== JSON.stringify(normalized))) {
    throw new Error(`${label} samples use inconsistent Extension Host runtimes.`);
  }
  if (!environment || environment.consistent !== true
    || environment.distinctProcessCount !== samples.length
    || JSON.stringify({
      node: environment.node,
      platform: environment.platform,
      arch: environment.arch,
      vscodeVersion: environment.vscodeVersion
    }) !== JSON.stringify(normalized)) {
    throw new Error(`${label}.environment.extensionHost does not match its raw samples.`);
  }
  return normalized;
}

function validateMeasurementMachine(environment, label) {
  const value = Object.freeze({
    platform: environment?.platform,
    arch: environment?.arch,
    cpuCount: environment?.cpuCount,
    cpuModel: environment?.cpuModel,
    totalMemoryBytes: environment?.totalMemoryBytes
  });
  if (typeof value.platform !== "string" || value.platform.length === 0
    || typeof value.arch !== "string" || value.arch.length === 0
    || !Number.isSafeInteger(value.cpuCount) || value.cpuCount <= 0
    || typeof value.cpuModel !== "string" || value.cpuModel.length === 0
    || !Number.isSafeInteger(value.totalMemoryBytes) || value.totalMemoryBytes <= 0) {
    throw new Error(`${label}.environment must identify the measurement machine class.`);
  }
  return value;
}

export async function verifyMeasuredVsix(report, label, requireCombinedVsix) {
  const artifactValue = report?.input?.artifact;
  if (typeof artifactValue !== "string" || artifactValue.length === 0) {
    throw new Error(`${label}.input.artifact must identify the measured VSIX.`);
  }
  const artifactFile = path.resolve(repositoryRoot, artifactValue);
  if (path.extname(artifactFile).toLowerCase() !== ".vsix" || !existsSync(artifactFile)) {
    throw new Error(`${label} measured VSIX does not exist: ${artifactFile}`);
  }
  const metrics = await readVsixArchiveMetrics(artifactFile);
  if (metrics.sha256 !== report.input.artifactSha256
    || metrics.archiveBytes !== report.input.artifactBytes) {
    throw new Error(`${label} measured VSIX bytes or SHA-256 no longer match the report.`);
  }
  const paths = new Set(metrics.entries.filter(entry => !entry.directory).map(entry => entry.path));
  const required = ["extension/package.json", "extension/bundle/extension.js"];
  if (requireCombinedVsix) {
    required.push(
      "extension/bundle/features/rsglHost.js",
      "extension/bundle/rsgl/server.js",
      "extension/bundle/rsgl/worker.js",
      "extension/bundle/model-preview.js"
    );
    if ([...paths].some(entryPath => entryPath.toLowerCase().endsWith(".js.map"))) {
      throw new Error("candidate combined production VSIX must not contain JavaScript source maps.");
    }
  }
  const missing = required.filter(entryPath => !paths.has(entryPath));
  if (missing.length > 0) {
    throw new Error(`${label} VSIX is missing required combined runtime entries: ${missing.join(", ")}.`);
  }
  return Object.freeze({
    path: relativeOrAbsolute(artifactFile),
    bytes: metrics.archiveBytes,
    sha256: metrics.sha256,
    fileCount: metrics.fileCount,
    combinedProduction: requireCombinedVsix
  });
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function assertMetricMatches(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the p95 recomputed from raw samples.`);
  }
}

function sum(samples, selector) {
  return samples.reduce((total, sample) => total + selector(sample), 0);
}

function readJsonReport(fileName, label) {
  if (!existsSync(fileName)) {
    throw new Error(`JSON-only activation ${label} report does not exist: ${fileName}`);
  }
  const bytes = readFileSync(fileName);
  try {
    return Object.freeze({ bytes, value: JSON.parse(bytes.toString("utf8")) });
  } catch (error) {
    throw new Error(`Unable to parse JSON-only activation ${label} report: ${fileName}`, {
      cause: error
    });
  }
}

function describeInput(fileName, bytes) {
  return Object.freeze({
    path: relativeOrAbsolute(fileName),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

function requireFiniteMetric(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function relativeOrAbsolute(fileName) {
  const relative = path.relative(repositoryRoot, fileName);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll("\\", "/")
    : path.resolve(fileName).replaceAll("\\", "/");
}

function pathIdentity(fileName) {
  const resolved = path.resolve(fileName);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function printUsage() {
  console.log([
    "Usage: node scripts/verify-json-only-activation-budget.mjs [--baseline report.json] [--candidate report.json] [--out report.json]",
    "",
    `Default baseline: ${defaultJsonOnlyActivationBudgetInputs.baseline}`,
    `Default candidate: ${defaultJsonOnlyActivationBudgetInputs.candidate}`,
    `Default output: ${defaultJsonOnlyActivationBudgetInputs.output}`
  ].join("\n"));
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? invoked.toLowerCase() === scriptFile.toLowerCase()
    : invoked === scriptFile;
}

if (isMainModule()) {
  try {
    const options = parseJsonOnlyActivationBudgetArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const result = await verifyJsonOnlyActivationBudget(options);
      console.log(`JSON-only Extension Host budget report: ${result.outputFile}`);
      console.log(`Activation p95 regression: ${result.report.comparison.activationRegressionMilliseconds.toFixed(3)} ms`);
      console.log(`Steady RSS p95 delta: ${result.report.comparison.steadyRssP95DeltaBytes} bytes`);
      console.log(`Release budget: ${result.report.passed ? "passed" : "failed"}`);
      if (!result.report.passed) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
