import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ActivationBudget {
  minimumIterations: number;
  minimumSteadyStateSettleMilliseconds: number;
  maximumAbsoluteP95RegressionMilliseconds: number;
  maximumRelativeP95RegressionRatio: number;
  maximumSteadyRssP95DeltaBytes: number;
}

interface Evaluation {
  comparison: {
    activationRegressionMilliseconds: number;
    activationAllowanceMilliseconds: number;
    steadyRssP95DeltaBytes: number;
  };
  gates: Record<string, boolean>;
  passed: boolean;
}

interface BudgetVerifierModule {
  compareJsonOnlyActivationReports(
    baseline: unknown,
    candidate: unknown,
    budget: ActivationBudget
  ): Evaluation;
}

interface ComparisonVerifierModule {
  validatePairedActivationComparisonStructure(report: unknown, budget: ActivationBudget): unknown;
}

interface ScheduleModule {
  createPairedActivationSchedule(iterations: number): {
    algorithm: string;
    iterationsPerArm: number;
    cycleLength: number;
    cycleCount: number;
    slots: Array<{
      slot: number;
      cycle: number;
      cycleSlot: number;
      arm: "baseline" | "candidate";
      armIteration: number;
    }>;
  };
}

interface HarnessIdentityModule {
  createActivationHarnessIdentity(): unknown;
}

interface MeasurementModule {
  validatePairedActivationComparisonInputs(options: {
    baselinePath: string;
    candidatePath: string;
    outputPath: string;
    iterationsPerArm: number;
    settleMilliseconds: number;
    workspacePath?: string;
  }): void;
}

interface ErrorFormatModule {
  formatErrorWithCauses(value: unknown): string;
}

describe("paired activation comparison evidence", () => {
  const repositoryRoot = process.cwd();
  const budget: ActivationBudget = {
    minimumIterations: 20,
    minimumSteadyStateSettleMilliseconds: 1000,
    maximumAbsoluteP95RegressionMilliseconds: 10,
    maximumRelativeP95RegressionRatio: 0.05,
    maximumSteadyRssP95DeltaBytes: 2 * 1024 * 1024
  };
  let budgetVerifier: BudgetVerifierModule;
  let comparisonVerifier: ComparisonVerifierModule;
  let scheduleModule: ScheduleModule;
  let harnessIdentityModule: HarnessIdentityModule;
  let measurementModule: MeasurementModule;
  let errorFormatModule: ErrorFormatModule;

  before(async () => {
    budgetVerifier = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "verify-json-only-activation-budget.mjs"
    )).href) as BudgetVerifierModule;
    comparisonVerifier = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "verify-json-only-activation-comparison.mjs"
    )).href) as ComparisonVerifierModule;
    scheduleModule = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "paired-schedule.mjs"
    )).href) as ScheduleModule;
    harnessIdentityModule = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "harness-identity.mjs"
    )).href) as HarnessIdentityModule;
    measurementModule = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "measure-json-only-activation-comparison.mjs"
    )).href) as MeasurementModule;
    errorFormatModule = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "error-format.mjs"
    )).href) as ErrorFormatModule;
  });

  it("accepts the canonical interleaved slot-to-sample binding", () => {
    const report = createReport();
    assert.doesNotThrow(() =>
      comparisonVerifier.validatePairedActivationComparisonStructure(report, budget));
  });

  it("rejects clustered/reordered execution and swapped sample bindings", () => {
    const clustered = createReport();
    clustered.executionSlots[1].arm = "baseline";
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(clustered, budget),
      /does not match the canonical schedule/
    );

    const rebound = createReport();
    rebound.executionSlots[0].sampleId = rebound.executionSlots[1].sampleId;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(rebound, budget),
      /not bound to its raw sample/
    );
  });

  it("rejects overlapping slots, unstable roots, and duplicate process instances", () => {
    const overlap = createReport();
    overlap.executionSlots[1].startedMonotonicMilliseconds =
      overlap.executionSlots[0].finishedMonotonicMilliseconds - 0.5;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(overlap, budget),
      /overlaps or reverses time/
    );

    const tooShort = createReport();
    tooShort.executionSlots[0].finishedMonotonicMilliseconds =
      tooShort.executionSlots[0].startedMonotonicMilliseconds + 999;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(tooShort, budget),
      /overlaps or reverses time/
    );

    const unboundTimeOrigin = createReport();
    const unbound = unboundTimeOrigin.measurementTimeOrigin - 2_000;
    unboundTimeOrigin.arms.baseline.samples[0].extensionHost.timeOrigin = unbound;
    unboundTimeOrigin.executionSlots[0].extensionHostTimeOrigin = unbound;
    unboundTimeOrigin.releaseEvaluation = budgetVerifier.compareJsonOnlyActivationReports(
      unboundTimeOrigin.arms.baseline,
      unboundTimeOrigin.arms.candidate,
      budget
    );
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(unboundTimeOrigin, budget),
      /unbound Extension Host time origin/
    );

    const wrongRoot = createReport();
    wrongRoot.arms.baseline.samples[0].activatedExtensionRoot = path.join(repositoryRoot, "wrong-root");
    wrongRoot.executionSlots[0].activatedExtensionRoot =
      wrongRoot.arms.baseline.samples[0].activatedExtensionRoot;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(wrongRoot, budget),
      /stable prepared extension root/
    );

    const duplicateProcess = createReport();
    duplicateProcess.arms.candidate.samples[0].extensionHost = {
      ...duplicateProcess.arms.baseline.samples[0].extensionHost
    };
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(duplicateProcess, budget),
      /distinct fresh Extension Host process instance|globally unique|disjoint Extension Host process instances/
    );
  });

  it("rejects arm parameter drift and forged release summaries", () => {
    const drift = createReport();
    drift.arms.candidate.input.settleMilliseconds = 1001;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(drift, budget),
      /identical iterations and settling time/
    );

    const forged = structuredClone(createReport());
    forged.releaseEvaluation.comparison.activationRegressionMilliseconds += 1;
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(forged, budget),
      /does not match recomputed raw samples/
    );

    const forgedHarness = structuredClone(createReport());
    (forgedHarness.harness as { sha256: string }).sha256 = "0".repeat(64);
    assert.throws(
      () => comparisonVerifier.validatePairedActivationComparisonStructure(forgedHarness, budget),
      /harness identity no longer matches/
    );
  });

  it("refuses to overwrite either measured VSIX with the report", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "paired-output-contract-"));
    try {
      const baselinePath = path.join(root, "baseline.vsix");
      const candidatePath = path.join(root, "candidate.vsix");
      fs.writeFileSync(baselinePath, "baseline");
      fs.writeFileSync(candidatePath, "candidate");
      assert.throws(() => measurementModule.validatePairedActivationComparisonInputs({
        baselinePath,
        candidatePath,
        outputPath: path.join(root, "report.json"),
        iterationsPerArm: 4,
        settleMilliseconds: 1000
      }), /requires at least 20 iterations per arm/);
      assert.throws(() => measurementModule.validatePairedActivationComparisonInputs({
        baselinePath,
        candidatePath,
        outputPath: candidatePath,
        iterationsPerArm: 20,
        settleMilliseconds: 1000
      }), /must not overwrite measured evidence/);
      const hardLinkedOutput = path.join(root, "hard-linked-report.json");
      fs.linkSync(candidatePath, hardLinkedOutput);
      assert.throws(() => measurementModule.validatePairedActivationComparisonInputs({
        baselinePath,
        candidatePath,
        outputPath: hardLinkedOutput,
        iterationsPerArm: 20,
        settleMilliseconds: 1000
      }), /must not be a hard-linked file/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders nested measurement failures without dropping the root cause", () => {
    const rootCause = new Error("Extension Host stderr details");
    const wrapped = new Error("raw samples retained", { cause: rootCause });
    const rendered = errorFormatModule.formatErrorWithCauses(wrapped);
    assert.match(rendered, /raw samples retained/);
    assert.match(rendered, /Caused by:/);
    assert.match(rendered, /Extension Host stderr details/);
  });

  function createReport() {
    const schedule = scheduleModule.createPairedActivationSchedule(20);
    const runner = runnerIdentity();
    const roots = {
      baseline: path.join(repositoryRoot, "dist", "contract-cache", "baseline", "extension"),
      candidate: path.join(repositoryRoot, "dist", "contract-cache", "candidate", "extension")
    };
    const arms = {
      baseline: createArm("baseline", "d", "a", 100, 200_000_000, roots.baseline, runner),
      candidate: createArm("candidate", "e", "b", 104, 201_000_000, roots.candidate, runner)
    };
    const executionSlots = schedule.slots.map(slot => {
      const sample = arms[slot.arm].samples[slot.armIteration];
      sample.extensionHost.pid = 10_000 + slot.slot;
      const startedMonotonicMilliseconds = slot.slot * 1_200;
      const finishedMonotonicMilliseconds = startedMonotonicMilliseconds + 1_100;
      sample.extensionHost.timeOrigin = 1_799_999_999_000
        + startedMonotonicMilliseconds + 100;
      return {
        ...slot,
        probeRunId: sample.probeRunId,
        sampleId: sample.sampleId,
        startedMonotonicMilliseconds,
        finishedMonotonicMilliseconds,
        extensionHostTimeOrigin: sample.extensionHost.timeOrigin,
        extensionHostPid: sample.extensionHost.pid,
        activatedExtensionRoot: sample.activatedExtensionRoot
      };
    });
    const releaseEvaluation = budgetVerifier.compareJsonOnlyActivationReports(
      arms.baseline,
      arms.candidate,
      budget
    );
    return {
      schemaVersion: 1,
      measurement: "json-only-activation-paired-comparison",
      repositoryCommit: "1".repeat(40),
      comparisonRunId: "f".repeat(32),
      trustBoundary: "Reproducible local measurement with canonical-code, artifact, process, schedule, and tree consistency checks; it detects stale or internally inconsistent evidence but is not a cryptographic attestation against deliberately fabricated telemetry.",
      measurementTimeOrigin: 1_799_999_999_000,
      input: {
        baseline: "baseline.vsix",
        candidate: "candidate.vsix",
        iterationsPerArm: 20,
        settleMilliseconds: 1000
      },
      runner: {
        path: "scripts/activation-probe/extension-host-sample.mjs",
        ...runner
      },
      harness: harnessIdentityModule.createActivationHarnessIdentity(),
      schedule,
      executionSlots,
      arms,
      releaseEvaluation,
      valid: true
    };
  }

  function createArm(
    arm: "baseline" | "candidate",
    probePrefix: string,
    artifactPrefix: string,
    activationP95: number,
    steadyRssP95: number,
    extensionRoot: string,
    runner: { bytes: number; sha256: string }
  ) {
    const probeRunId = probePrefix.repeat(32);
    const artifactSha256 = artifactPrefix.repeat(64);
    const samples = Array.from({ length: 20 }, (_, iteration) => ({
      schemaVersion: 3,
      adapter: "extension-host",
      probeRunId,
      sampleId: `${probePrefix}${iteration.toString(16).padStart(31, "0")}`,
      artifact: { bytes: 1024, sha256: artifactSha256 },
      iteration,
      status: "ok",
      activatedExtensionRoot: extensionRoot,
      extensionHost: {
        pid: 1,
        timeOrigin: 1,
        sessionId: `${arm}-session-${iteration}`,
        node: "v22.0.0",
        platform: "win32",
        arch: "x64",
        vscodeVersion: "1.109.0"
      },
      activationMilliseconds: activationP95,
      rssBeforeBytes: steadyRssP95 - 1024,
      rssAfterActivationBytes: steadyRssP95,
      steadyRssBytes: steadyRssP95,
      rssDeltaBytes: 1024,
      installedHooks: requiredHooks(),
      moduleLoads: [],
      processSpawns: [],
      workerSpawns: [],
      filesystemWalks: [],
      watcherRegistrations: [{
        api: "vscode.workspace.createFileSystemWatcher",
        target: "**/pack.mcmeta",
        extensionOwned: true,
        rsgl: false
      }],
      instrumentationWarnings: []
    }));
    return {
      schemaVersion: 3,
      measurement: "json-only-activation",
      repositoryCommit: "1".repeat(40),
      probeRunId,
      scope: {
        adapter: "extension-host",
        isExtensionHost: true,
        isCombinedVsix: arm === "candidate",
        artifactKind: arm === "candidate" ? "combined-vsix" : "vsix",
        canonicalRunner: true,
        runnerProtocol: { version: 3 }
      },
      input: {
        artifact: `${arm}.vsix`,
        artifactBytes: 1024,
        artifactSha256,
        runner: "scripts/activation-probe/extension-host-sample.mjs",
        runnerBytes: runner.bytes,
        runnerSha256: runner.sha256,
        preparedExtension: {
          artifact: { bytes: 1024, sha256: artifactSha256 },
          extensionRoot,
          cacheEntryRoot: path.dirname(extensionRoot),
          markerPath: path.join(path.dirname(extensionRoot), "prepared-vsix.json")
        },
        iterations: 20,
        settleMilliseconds: 1000
      },
      environment: {
        platform: "win32",
        arch: "x64",
        cpuCount: 8,
        cpuModel: "contract CPU",
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        extensionHost: {
          node: "v22.0.0",
          platform: "win32",
          arch: "x64",
          vscodeVersion: "1.109.0",
          consistent: true
        }
      },
      summary: {
        successfulSamples: 20,
        failedSamples: 0,
        distinctPidCount: 20,
        distinctProcessInstanceCount: 20,
        distinctSessionCount: 20,
        pidReuseCount: 0,
        activationMilliseconds: { p95: activationP95 },
        steadyRssBytes: { p95: steadyRssP95 }
      },
      hardConditions: {
        rsglModuleLoadsZero: true,
        rsglProcessSpawnAttemptsZero: true,
        rsglWorkerSpawnAttemptsZero: true,
        rsglFilesystemWalksZero: true,
        mainWatcherRegistrationsPositive: true,
        rsglWatcherRegistrationsZero: true,
        instrumentationWarningsZero: true,
        counts: {
          rsglModuleLoads: 0,
          rsglProcessSpawnAttempts: 0,
          rsglWorkerSpawnAttempts: 0,
          extensionOwnedNonRsglProcessSpawns: 0,
          hostProcessSpawnNoise: 0,
          rsglFilesystemWalks: 0,
          mainWatcherRegistrations: 20,
          samplesMissingMainWatcherPositiveControl: 0,
          rsglWatcherRegistrations: 0,
          instrumentationWarnings: 0
        },
        passed: true
      },
      valid: true,
      samples
    };
  }

  function runnerIdentity(): { bytes: number; sha256: string } {
    const contents = fs.readFileSync(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "extension-host-sample.mjs"
    ));
    return {
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex")
    };
  }

  function requiredHooks(): string[] {
    return [
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
    ];
  }
});
