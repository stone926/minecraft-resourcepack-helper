#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { parseFlagValues } from "./lib/cli-args.mjs";
import { readRepositoryCommit } from "./lib/git.mjs";
import { parseInteger, shellDisplayArgument } from "./lib/parse.mjs";
import { pathIdentity, relativeOrAbsoluteFrom } from "./lib/paths.mjs";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  canonicalExtensionHostSampleRunner,
  runExtensionHostSampleProcess
} from "./activation-probe/extension-host-sample-process.mjs";
import {
  createPairedActivationSchedule
} from "./activation-probe/paired-schedule.mjs";
import {
  hashPreparedExtensionTree,
  prepareVsixExtension,
  resolvePreparedVsixCacheRoot
} from "./activation-probe/prepared-vsix.mjs";
import { createActivationHarnessIdentity } from "./activation-probe/harness-identity.mjs";
import { formatErrorWithCauses } from "./activation-probe/error-format.mjs";
import { assertSafeEvidenceOutput } from "./activation-probe/safe-output.mjs";
import {
  assertJsonOnlyWorkspace,
  createActivationProbeReport,
  createChallenge,
  createJsonOnlyWorkspace,
  describeArtifact
} from "./measure-json-only-activation.mjs";
import { activationEvidenceTrustBoundary } from "./activation-probe/schema.mjs";
import { readBuildBudgetConfiguration } from "./build-budget-config.mjs";
import { compareJsonOnlyActivationReports } from "./verify-json-only-activation-budget.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const relativeOrAbsolute = relativeOrAbsoluteFrom(repositoryRoot);

export const pairedActivationComparisonSchemaVersion = 1;
export const defaultPairedActivationComparisonInputs = Object.freeze({
  baseline: "dist/minecraft-resourcepack-helper-final-a.vsix",
  candidate: "dist/measurements/combined-production.vsix",
  output: "dist/measurements/json-only-activation-comparison.json",
  iterationsPerArm: 20,
  settleMilliseconds: 1_000
});

export function parsePairedActivationComparisonArguments(args) {
  const { values, help } = parseFlagValues(args, {
    helpArguments: ["--help", "-h"],
    eagerKnownFlags: ["--baseline", "--candidate", "--out", "--iterations", "--settle-ms", "--workspace", "--code"],
    unknownArgument: argument => `Unknown paired activation comparison argument: ${argument}`
  });
  return Object.freeze({
    help,
    baselinePath: path.resolve(repositoryRoot, values.get("--baseline")
      ?? defaultPairedActivationComparisonInputs.baseline),
    candidatePath: path.resolve(repositoryRoot, values.get("--candidate")
      ?? defaultPairedActivationComparisonInputs.candidate),
    outputPath: path.resolve(repositoryRoot, values.get("--out")
      ?? defaultPairedActivationComparisonInputs.output),
    iterationsPerArm: parseInteger(
      values.get("--iterations") ?? String(defaultPairedActivationComparisonInputs.iterationsPerArm),
      "--iterations",
      4,
      1_000,
      4
    ),
    settleMilliseconds: parseInteger(
      values.get("--settle-ms") ?? String(defaultPairedActivationComparisonInputs.settleMilliseconds),
      "--settle-ms",
      0,
      10_000
    ),
    workspacePath: values.has("--workspace")
      ? path.resolve(repositoryRoot, values.get("--workspace"))
      : undefined,
    codeExecutable: values.has("--code")
      ? path.resolve(repositoryRoot, values.get("--code"))
      : undefined
  });
}

export async function measurePairedActivationComparison(options) {
  validatePairedActivationComparisonInputs(options);
  const schedule = createPairedActivationSchedule(options.iterationsPerArm);
  const comparisonRunId = createChallenge();
  const ownedWorkspaceRoot = options.workspacePath ? undefined : createJsonOnlyWorkspace();
  const workspaceRoot = options.workspacePath ?? ownedWorkspaceRoot;
  const sampleRoot = mkdtempSync(path.join(os.tmpdir(), "mcres-paired-activation-"));
  let retainSampleRoot = false;
  try {
    assertJsonOnlyWorkspace(workspaceRoot);
    const [baselinePrepared, candidatePrepared] = await Promise.all([
      prepareVsixExtension({ artifactPath: options.baselinePath, repositoryRoot }),
      prepareVsixExtension({ artifactPath: options.candidatePath, repositoryRoot })
    ]);
    await Promise.all([
      assertPreparedReadback(baselinePrepared),
      assertPreparedReadback(candidatePrepared)
    ]);
    const runnerIdentity = describeArtifact(canonicalExtensionHostSampleRunner);
    const harnessIdentity = createActivationHarnessIdentity();
    const arms = {
      baseline: createArmState(
        "baseline",
        options.baselinePath,
        "vsix",
        baselinePrepared
      ),
      candidate: createArmState(
        "candidate",
        options.candidatePath,
        "combined-vsix",
        candidatePrepared
      )
    };
    const executionSlots = [];
    for (const slot of schedule.slots) {
      const arm = arms[slot.arm];
      const sampleId = createChallenge();
      const sampleOutput = path.join(sampleRoot, `slot-${String(slot.slot).padStart(3, "0")}.json`);
      await assertPreparedReadback(arm.prepared);
      const startedMonotonicMilliseconds = performance.now();
      const sample = runExtensionHostSampleProcess({
        artifactPath: arm.artifactPath,
        extensionRoot: arm.prepared.extensionRoot,
        workspaceRoot,
        iteration: slot.armIteration,
        settleMilliseconds: options.settleMilliseconds,
        sampleOutput,
        probeRunId: arm.probeRunId,
        sampleId,
        artifact: arm.prepared.artifact,
        codeExecutable: options.codeExecutable,
        cwd: repositoryRoot,
        timeoutMilliseconds: 180_000
      });
      const finishedMonotonicMilliseconds = performance.now();
      await assertPreparedReadback(arm.prepared);
      arm.samples.push(sample);
      executionSlots.push(Object.freeze({
        ...slot,
        probeRunId: arm.probeRunId,
        sampleId,
        startedMonotonicMilliseconds,
        finishedMonotonicMilliseconds,
        extensionHostTimeOrigin: sample.extensionHost.timeOrigin,
        extensionHostPid: sample.extensionHost.pid,
        activatedExtensionRoot: sample.activatedExtensionRoot
      }));
    }

    await assertInputsUnchanged(arms, runnerIdentity, harnessIdentity);
    const armReports = Object.freeze({
      baseline: createArmReport(arms.baseline, options, workspaceRoot, runnerIdentity),
      candidate: createArmReport(arms.candidate, options, workspaceRoot, runnerIdentity)
    });
    const budget = readBuildBudgetConfiguration().jsonOnlyExtensionHost;
    const releaseEvaluation = compareJsonOnlyActivationReports(
      armReports.baseline,
      armReports.candidate,
      budget
    );
    const report = Object.freeze({
      schemaVersion: pairedActivationComparisonSchemaVersion,
      measurement: "json-only-activation-paired-comparison",
      generatedAt: new Date().toISOString(),
      repositoryCommit: readRepositoryCommit(repositoryRoot),
      comparisonRunId,
      trustBoundary: activationEvidenceTrustBoundary,
      measurementTimeOrigin: performance.timeOrigin,
      command: createReproductionCommand(options),
      input: Object.freeze({
        baseline: relativeOrAbsolute(options.baselinePath),
        candidate: relativeOrAbsolute(options.candidatePath),
        iterationsPerArm: options.iterationsPerArm,
        settleMilliseconds: options.settleMilliseconds,
        workspace: options.workspacePath
          ? relativeOrAbsolute(workspaceRoot)
          : "generated-json-only-pack"
      }),
      runner: Object.freeze({
        path: relativeOrAbsolute(canonicalExtensionHostSampleRunner),
        ...runnerIdentity
      }),
      harness: harnessIdentity,
      schedule,
      executionSlots: Object.freeze(executionSlots),
      arms: armReports,
      releaseEvaluation,
      valid: releaseEvaluation.passed === true
        && armReports.baseline.valid === true
        && armReports.candidate.valid === true
    });
    mkdirSync(path.dirname(options.outputPath), { recursive: true });
    assertPairedActivationOutputSafety(options);
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    retainSampleRoot = true;
    throw new Error(
      `Paired activation measurement failed; raw sample files were retained at ${sampleRoot}.`,
      { cause: error }
    );
  } finally {
    if (!retainSampleRoot) {
      rmSync(sampleRoot, { recursive: true, force: true });
    }
    if (ownedWorkspaceRoot) {
      rmSync(ownedWorkspaceRoot, { recursive: true, force: true });
    }
  }
}

function createArmState(name, artifactPath, artifactKind, prepared) {
  return {
    name,
    artifactPath,
    artifactKind,
    prepared,
    probeRunId: createChallenge(),
    samples: []
  };
}

function createArmReport(arm, options, workspaceRoot, runnerIdentity) {
  return createActivationProbeReport(
    {
      adapter: "extension-host",
      runnerPath: canonicalExtensionHostSampleRunner,
      artifactPath: arm.artifactPath,
      artifactKind: arm.artifactKind,
      iterations: options.iterationsPerArm,
      settleMilliseconds: options.settleMilliseconds,
      outputPath: options.outputPath,
      workspacePath: options.workspacePath
    },
    workspaceRoot,
    arm.probeRunId,
    arm.prepared.artifact,
    runnerIdentity,
    arm.prepared,
    arm.samples
  );
}

async function assertInputsUnchanged(arms, runnerIdentity, harnessIdentity) {
  const runnerAfter = describeArtifact(canonicalExtensionHostSampleRunner);
  if (!sameIdentity(runnerAfter, runnerIdentity)) {
    throw new Error("Canonical Extension Host runner changed during paired measurement.");
  }
  if (createActivationHarnessIdentity().sha256 !== harnessIdentity.sha256) {
    throw new Error("Activation measurement harness changed during paired measurement.");
  }
  for (const arm of Object.values(arms)) {
    const artifactAfter = describeArtifact(arm.artifactPath);
    if (!sameIdentity(artifactAfter, arm.prepared.artifact)) {
      throw new Error(`${arm.name} VSIX changed during paired measurement.`);
    }
    await assertPreparedReadback(arm.prepared);
  }
}

async function assertPreparedReadback(prepared) {
  const actual = await hashPreparedExtensionTree(prepared.extensionRoot);
  if (JSON.stringify(actual) !== JSON.stringify(prepared.extensionTree)
    || JSON.stringify(actual) !== JSON.stringify(prepared.extractedTree)) {
    throw new Error("Prepared VSIX tree changed before paired activation completed.");
  }
}

function sameIdentity(left, right) {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

export function validatePairedActivationComparisonInputs(options) {
  const releaseBudget = readBuildBudgetConfiguration().jsonOnlyExtensionHost;
  if (!Number.isSafeInteger(options.iterationsPerArm)
    || options.iterationsPerArm < releaseBudget.minimumIterations) {
    throw new Error(
      `Paired activation release evidence requires at least ${releaseBudget.minimumIterations} iterations per arm.`
    );
  }
  if (!Number.isSafeInteger(options.settleMilliseconds)
    || options.settleMilliseconds < releaseBudget.minimumSteadyStateSettleMilliseconds) {
    throw new Error(
      `Paired activation release evidence requires at least ${releaseBudget.minimumSteadyStateSettleMilliseconds} ms settling time.`
    );
  }
  for (const [label, fileName] of [
    ["baseline", options.baselinePath],
    ["candidate", options.candidatePath]
  ]) {
    const details = statSync(fileName);
    if (!details.isFile() || path.extname(fileName).toLowerCase() !== ".vsix") {
      throw new Error(`Paired activation ${label} must be an existing VSIX file: ${fileName}`);
    }
  }
  if (pathIdentity(options.baselinePath) === pathIdentity(options.candidatePath)) {
    throw new Error("Paired activation baseline and candidate VSIX paths must be distinct.");
  }
  if (options.workspacePath && !statSync(options.workspacePath).isDirectory()) {
    throw new Error(`Paired activation workspace must be a directory: ${options.workspacePath}`);
  }
  assertPairedActivationOutputSafety(options);
}

function assertPairedActivationOutputSafety(options) {
  assertSafeEvidenceOutput({
    outputPath: options.outputPath,
    protectedFiles: [options.baselinePath, options.candidatePath],
    protectedDirectories: [
      resolvePreparedVsixCacheRoot(repositoryRoot),
      ...(options.workspacePath ? [options.workspacePath] : [])
    ],
    label: "Paired activation"
  });
}

function createReproductionCommand(options) {
  const args = [
    "node",
    "scripts/measure-json-only-activation-comparison.mjs",
    "--baseline", relativeOrAbsolute(options.baselinePath),
    "--candidate", relativeOrAbsolute(options.candidatePath),
    "--iterations", String(options.iterationsPerArm),
    "--settle-ms", String(options.settleMilliseconds),
    "--out", relativeOrAbsolute(options.outputPath)
  ];
  if (options.workspacePath) {
    args.push("--workspace", relativeOrAbsolute(options.workspacePath));
  }
  if (options.codeExecutable) {
    args.push("--code", options.codeExecutable);
  }
  return args.map(shellDisplayArgument).join(" ");
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/measure-json-only-activation-comparison.mjs [--baseline path] [--candidate path] [--iterations 20] [--settle-ms 1000] [--out path]",
    "",
    "Runs the canonical balanced ABBA/BAAB schedule against stable content-addressed VSIX roots."
  ].join("\n"));
}


if (isMainModule(import.meta.url)) {
  try {
    const options = parsePairedActivationComparisonArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const report = await measurePairedActivationComparison(options);
      console.log(`Paired JSON-only activation report: ${options.outputPath}`);
      console.log(`Schedule: ${report.schedule.algorithm} (${report.schedule.slots.length} slots)`);
      console.log(`Activation p95 delta ms: ${report.releaseEvaluation.comparison.activationRegressionMilliseconds.toFixed(3)}`);
      console.log(`Steady RSS p95 delta bytes: ${report.releaseEvaluation.comparison.steadyRssP95DeltaBytes}`);
      console.log(`Release gates: ${report.valid ? "passed" : "failed"}`);
      if (!report.valid) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(formatErrorWithCauses(error));
    process.exitCode = 1;
  }
}
