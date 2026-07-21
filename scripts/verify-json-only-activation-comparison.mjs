#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalExtensionHostSampleRunner
} from "./activation-probe/extension-host-sample-process.mjs";
import { createActivationHarnessIdentity } from "./activation-probe/harness-identity.mjs";
import { formatErrorWithCauses } from "./activation-probe/error-format.mjs";
import { assertSafeEvidenceOutput } from "./activation-probe/safe-output.mjs";
import {
  validatePairedActivationSchedule
} from "./activation-probe/paired-schedule.mjs";
import {
  prepareVsixExtension,
  resolvePreparedVsixCacheRoot
} from "./activation-probe/prepared-vsix.mjs";
import {
  activationEvidenceTrustBoundary,
  extensionHostProcessInstanceKey,
  isActivationProbeIdentifier
} from "./activation-probe/schema.mjs";
import { readBuildBudgetConfiguration } from "./build-budget-config.mjs";
import {
  compareJsonOnlyActivationReports,
  verifyMeasuredVsix
} from "./verify-json-only-activation-budget.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const EXTENSION_HOST_TIME_ORIGIN_TOLERANCE_MILLISECONDS = 1_000;

export const pairedActivationComparisonSchemaVersion = 1;
export const defaultPairedActivationVerificationInputs = Object.freeze({
  report: "dist/measurements/json-only-activation-comparison.json",
  output: "dist/measurements/json-only-activation-comparison-verification.json"
});

export function parsePairedActivationVerificationArguments(args) {
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
    if (!["--report", "--out"].includes(flag)) {
      throw new Error(`Unknown paired activation verification argument: ${argument}`);
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
  const reportFile = path.resolve(repositoryRoot, values.get("--report")
    ?? defaultPairedActivationVerificationInputs.report);
  const outputFile = path.resolve(repositoryRoot, values.get("--out")
    ?? defaultPairedActivationVerificationInputs.output);
  if (pathIdentity(reportFile) === pathIdentity(outputFile)) {
    throw new Error("Paired activation report and verification output paths must be distinct.");
  }
  return Object.freeze({ help, reportFile, outputFile });
}

export async function verifyPairedActivationComparison(options) {
  const inputBytes = readFileSync(options.reportFile);
  let report;
  try {
    report = JSON.parse(inputBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Paired activation report is not valid JSON: ${options.reportFile}`, { cause: error });
  }
  const budget = readBuildBudgetConfiguration().jsonOnlyExtensionHost;
  const structure = validatePairedActivationComparisonStructure(report, budget);
  assertVerificationOutputSafety(options.outputFile, report);
  const artifacts = Object.freeze({
    baseline: await verifyMeasuredVsix(report.arms.baseline, "baseline", false),
    candidate: await verifyMeasuredVsix(report.arms.candidate, "candidate", true)
  });
  const prepared = Object.freeze({
    baseline: await verifyPreparedArm(report.arms.baseline, "baseline"),
    candidate: await verifyPreparedArm(report.arms.candidate, "candidate")
  });
  if (pathIdentity(prepared.baseline.extensionRoot)
    === pathIdentity(prepared.candidate.extensionRoot)) {
    throw new Error("Paired activation arms must use distinct prepared extension roots.");
  }
  const verification = Object.freeze({
    schemaVersion: 1,
    measurement: "json-only-activation-paired-comparison-verification",
    generatedAt: new Date().toISOString(),
    input: Object.freeze({
      path: relativeOrAbsolute(options.reportFile),
      bytes: inputBytes.length,
      sha256: createHash("sha256").update(inputBytes).digest("hex")
    }),
    artifacts,
    prepared,
    comparison: structure.releaseEvaluation.comparison,
    gates: structure.releaseEvaluation.gates,
    passed: true
  });
  mkdirSync(path.dirname(options.outputFile), { recursive: true });
  assertVerificationOutputSafety(options.outputFile, report);
  writeFileSync(options.outputFile, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  return Object.freeze({ report: verification, outputFile: options.outputFile });
}

export function validatePairedActivationComparisonStructure(report, budget) {
  if (!report || typeof report !== "object"
    || report.schemaVersion !== pairedActivationComparisonSchemaVersion
    || report.measurement !== "json-only-activation-paired-comparison") {
    throw new Error("Unsupported paired activation comparison report.");
  }
  if (!isActivationProbeIdentifier(report.comparisonRunId)) {
    throw new Error("Paired activation comparisonRunId must be a probe challenge.");
  }
  if (report.trustBoundary !== activationEvidenceTrustBoundary) {
    throw new Error("Paired activation report must state the canonical evidence trust boundary.");
  }
  const schedule = validatePairedActivationSchedule(report.schedule);
  if (report.input?.iterationsPerArm !== schedule.iterationsPerArm) {
    throw new Error("Paired activation input iterations do not match the schedule.");
  }
  const settleMilliseconds = requireNonNegativeInteger(
    report.input?.settleMilliseconds,
    "paired activation settleMilliseconds"
  );
  const baseline = report.arms?.baseline;
  const candidate = report.arms?.candidate;
  if (!baseline || !candidate) {
    throw new Error("Paired activation report must contain baseline and candidate arms.");
  }
  if (!/^[a-f0-9]{40}$/.test(report.repositoryCommit)
    || baseline.repositoryCommit !== report.repositoryCommit
    || candidate.repositoryCommit !== report.repositoryCommit) {
    throw new Error("Paired activation report and both arms must identify one repository commit.");
  }
  if (pathIdentity(path.resolve(repositoryRoot, report.input?.baseline ?? ""))
      !== pathIdentity(path.resolve(repositoryRoot, baseline.input?.artifact ?? ""))
    || pathIdentity(path.resolve(repositoryRoot, report.input?.candidate ?? ""))
      !== pathIdentity(path.resolve(repositoryRoot, candidate.input?.artifact ?? ""))) {
    throw new Error("Paired activation top-level artifact paths do not match their arms.");
  }
  if (baseline.input?.iterations !== schedule.iterationsPerArm
    || candidate.input?.iterations !== schedule.iterationsPerArm
    || baseline.input?.settleMilliseconds !== settleMilliseconds
    || candidate.input?.settleMilliseconds !== settleMilliseconds) {
    throw new Error("Paired activation arms must use identical iterations and settling time.");
  }
  if (baseline.probeRunId === candidate.probeRunId
    || report.comparisonRunId === baseline.probeRunId
    || report.comparisonRunId === candidate.probeRunId) {
    throw new Error("Paired activation comparison and arm challenges must be distinct.");
  }
  const releaseEvaluation = compareJsonOnlyActivationReports(baseline, candidate, budget);
  if (releaseEvaluation.passed !== true || report.valid !== true) {
    throw new Error("Paired activation comparison did not pass its release gates.");
  }
  if (JSON.stringify(report.releaseEvaluation) !== JSON.stringify(releaseEvaluation)) {
    throw new Error("Paired activation release evaluation does not match recomputed raw samples.");
  }
  validateRunnerIdentity(report.runner, baseline, candidate);
  validateHarnessIdentity(report.harness);
  validateExecutionSlots(report, schedule, baseline, candidate, settleMilliseconds);
  return Object.freeze({ schedule, releaseEvaluation });
}

function validateHarnessIdentity(claim) {
  const actual = createActivationHarnessIdentity();
  if (JSON.stringify(claim) !== JSON.stringify(actual)) {
    throw new Error("Paired activation harness identity no longer matches the report.");
  }
}

function validateRunnerIdentity(runner, baseline, candidate) {
  if (!runner || typeof runner !== "object"
    || pathIdentity(path.resolve(repositoryRoot, runner.path ?? ""))
      !== pathIdentity(canonicalExtensionHostSampleRunner)
    || !Number.isSafeInteger(runner.bytes) || runner.bytes <= 0
    || typeof runner.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(runner.sha256)) {
    throw new Error("Paired activation report does not identify the canonical runner.");
  }
  for (const [label, arm] of [["baseline", baseline], ["candidate", candidate]]) {
    if (arm.input?.runnerBytes !== runner.bytes
      || arm.input?.runnerSha256 !== runner.sha256
      || pathIdentity(path.resolve(repositoryRoot, arm.input?.runner ?? ""))
        !== pathIdentity(canonicalExtensionHostSampleRunner)) {
      throw new Error(`${label} arm runner identity does not match the paired report.`);
    }
  }
}

function validateExecutionSlots(report, schedule, baseline, candidate, settleMilliseconds) {
  if (!Number.isFinite(report.measurementTimeOrigin) || report.measurementTimeOrigin <= 0) {
    throw new Error("Paired activation measurementTimeOrigin must identify the orchestrator process.");
  }
  if (!Array.isArray(report.executionSlots)
    || report.executionSlots.length !== schedule.slots.length) {
    throw new Error("Paired activation execution slot count does not match the schedule.");
  }
  const samplesByArm = {
    baseline: indexSamples(baseline.samples, schedule.iterationsPerArm, "baseline"),
    candidate: indexSamples(candidate.samples, schedule.iterationsPerArm, "candidate")
  };
  const allSampleIds = new Set();
  const allProcessInstances = new Set();
  let previousFinished = -Infinity;
  for (let index = 0; index < schedule.slots.length; index += 1) {
    const expected = schedule.slots[index];
    const actual = report.executionSlots[index];
    for (const key of ["slot", "cycle", "cycleSlot", "arm", "armIteration"]) {
      if (actual?.[key] !== expected[key]) {
        throw new Error(`Paired activation execution slot ${index} does not match the canonical schedule.`);
      }
    }
    const sample = samplesByArm[expected.arm].get(expected.armIteration);
    if (!sample
      || actual.sampleId !== sample.sampleId
      || actual.probeRunId !== sample.probeRunId
      || actual.extensionHostPid !== sample.extensionHost.pid
      || actual.extensionHostTimeOrigin !== sample.extensionHost.timeOrigin
      || pathIdentity(actual.activatedExtensionRoot)
        !== pathIdentity(sample.activatedExtensionRoot)) {
      throw new Error(`Paired activation execution slot ${index} is not bound to its raw sample.`);
    }
    const started = requireFinite(actual.startedMonotonicMilliseconds, `slot ${index} start`);
    const finished = requireFinite(actual.finishedMonotonicMilliseconds, `slot ${index} finish`);
    if (started < previousFinished || finished <= started
      || finished - started < settleMilliseconds) {
      throw new Error(`Paired activation execution slot ${index} overlaps or reverses time.`);
    }
    const startedEpoch = report.measurementTimeOrigin + started;
    const finishedEpoch = report.measurementTimeOrigin + finished;
    if (sample.extensionHost.timeOrigin
        < startedEpoch - EXTENSION_HOST_TIME_ORIGIN_TOLERANCE_MILLISECONDS
      || sample.extensionHost.timeOrigin
        > finishedEpoch + EXTENSION_HOST_TIME_ORIGIN_TOLERANCE_MILLISECONDS) {
      throw new Error(`Paired activation execution slot ${index} has an unbound Extension Host time origin.`);
    }
    previousFinished = finished;
    if (allSampleIds.has(sample.sampleId)) {
      throw new Error("Paired activation sample challenges must be globally unique.");
    }
    allSampleIds.add(sample.sampleId);
    const processKey = extensionHostProcessInstanceKey(sample.extensionHost);
    if (allProcessInstances.has(processKey)) {
      throw new Error("Paired activation process instances must be globally unique.");
    }
    allProcessInstances.add(processKey);
  }
  validateStableArmRoot(baseline, "baseline");
  validateStableArmRoot(candidate, "candidate");
  if (pathIdentity(baseline.input.preparedExtension.extensionRoot)
    === pathIdentity(candidate.input.preparedExtension.extensionRoot)) {
    throw new Error("Paired activation arms must not share one prepared extension root.");
  }
}

function assertVerificationOutputSafety(outputFile, report) {
  const protectedFiles = [
    report.arms?.baseline?.input?.artifact,
    report.arms?.candidate?.input?.artifact
  ].filter(value => typeof value === "string" && value.length > 0)
    .map(value => path.resolve(repositoryRoot, value));
  const protectedDirectories = [
    report.arms?.baseline?.input?.preparedExtension?.cacheEntryRoot,
    report.arms?.candidate?.input?.preparedExtension?.cacheEntryRoot
  ].filter(value => typeof value === "string" && value.length > 0)
    .map(value => path.resolve(repositoryRoot, value));
  assertSafeEvidenceOutput({
    outputPath: outputFile,
    protectedFiles,
    protectedDirectories: [
      resolvePreparedVsixCacheRoot(repositoryRoot),
      ...protectedDirectories
    ],
    label: "Paired activation verification"
  });
}

function indexSamples(samples, iterations, label) {
  if (!Array.isArray(samples) || samples.length !== iterations) {
    throw new Error(`${label} arm raw sample count does not match the schedule.`);
  }
  const indexed = new Map();
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.iteration) || sample.iteration < 0
      || sample.iteration >= iterations || indexed.has(sample.iteration)) {
      throw new Error(`${label} arm raw samples do not have unique canonical iterations.`);
    }
    indexed.set(sample.iteration, sample);
  }
  return indexed;
}

function validateStableArmRoot(arm, label) {
  const claim = arm.input?.preparedExtension;
  if (!claim || typeof claim !== "object"
    || typeof claim.extensionRoot !== "string" || claim.extensionRoot.length === 0) {
    throw new Error(`${label} arm does not identify its prepared extension root.`);
  }
  const expected = path.resolve(repositoryRoot, claim.extensionRoot);
  for (const sample of arm.samples) {
    if (pathIdentity(sample.activatedExtensionRoot) !== pathIdentity(expected)) {
      throw new Error(`${label} arm did not activate one stable prepared extension root.`);
    }
  }
}

async function verifyPreparedArm(arm, label) {
  const claim = arm.input?.preparedExtension;
  const artifactPath = path.resolve(repositoryRoot, arm.input?.artifact ?? "");
  const actual = await prepareVsixExtension({ artifactPath, repositoryRoot });
  if (actual.artifact.sha256 !== arm.input.artifactSha256
    || actual.artifact.bytes !== arm.input.artifactBytes
    || claim?.artifact?.sha256 !== actual.artifact.sha256
    || claim?.artifact?.bytes !== actual.artifact.bytes
    || !sameTree(actual.extensionTree, claim?.extensionTree)
    || !sameTree(actual.extractedTree, claim?.extractedTree)
    || pathIdentity(actual.extensionRoot)
      !== pathIdentity(path.resolve(repositoryRoot, claim?.extensionRoot ?? ""))
    || pathIdentity(actual.cacheEntryRoot)
      !== pathIdentity(path.resolve(repositoryRoot, claim?.cacheEntryRoot ?? ""))
    || pathIdentity(actual.markerPath)
      !== pathIdentity(path.resolve(repositoryRoot, claim?.markerPath ?? ""))) {
    throw new Error(`${label} prepared extension cache no longer matches the measured evidence.`);
  }
  return Object.freeze({
    artifact: actual.artifact,
    extensionRoot: relativeOrAbsolute(actual.extensionRoot),
    extensionTree: actual.extensionTree
  });
}

function sameTree(left, right) {
  return left?.algorithm === right?.algorithm
    && left?.sha256 === right?.sha256
    && left?.files === right?.files
    && left?.directories === right?.directories
    && left?.bytes === right?.bytes;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireFinite(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function relativeOrAbsolute(fileName) {
  const relative = path.relative(repositoryRoot, path.resolve(fileName));
  return relative && !path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    ? relative.replaceAll("\\", "/")
    : path.resolve(fileName);
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}


function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/verify-json-only-activation-comparison.mjs [--report path] [--out path]"
  ].join("\n"));
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return pathIdentity(process.argv[1]) === pathIdentity(scriptFile);
}

if (isMainModule()) {
  try {
    const options = parsePairedActivationVerificationArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const result = await verifyPairedActivationComparison(options);
      console.log(`Paired activation verification: ${result.outputFile}`);
      console.log("Release gates: passed");
    }
  } catch (error) {
    console.error(formatErrorWithCauses(error));
    process.exitCode = 1;
  }
}
