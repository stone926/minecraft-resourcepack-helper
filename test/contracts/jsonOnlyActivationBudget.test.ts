import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ActivationBudget {
  minimumIterations: number;
  minimumSteadyStateSettleMilliseconds: number;
  maximumAbsoluteP95RegressionMilliseconds: number;
  maximumRelativeP95RegressionRatio: number;
  maximumSteadyRssP95DeltaBytes: number;
}

interface BudgetModule {
  defaultJsonOnlyActivationBudgetInputs: {
    baseline: string;
    candidate: string;
    output: string;
  };
  parseJsonOnlyActivationBudgetArguments(args: string[]): {
    help: boolean;
    baselineFile: string;
    candidateFile: string;
    outputFile: string;
  };
  compareJsonOnlyActivationReports(
    baseline: unknown,
    candidate: unknown,
    budget: ActivationBudget
  ): {
    comparison: {
      activationRegressionMilliseconds: number;
      activationAllowanceMilliseconds: number;
      steadyRssP95DeltaBytes: number;
    };
    gates: Record<string, boolean>;
    passed: boolean;
  };
  verifyMeasuredVsix(
    report: unknown,
    label: string,
    requireCombinedVsix: boolean
  ): Promise<{ combinedProduction: boolean; sha256: string }>;
}

interface YazlZipFile {
  addBuffer(buffer: Buffer, metadataPath: string): void;
  end(): void;
  outputStream: NodeJS.ReadableStream;
}

const moduleRequire = createRequire(__filename);

describe("JSON-only real Extension Host release budget", () => {
  const repositoryRoot = process.cwd();
  const script = path.join(repositoryRoot, "scripts", "verify-json-only-activation-budget.mjs");
  const budget: ActivationBudget = {
    minimumIterations: 20,
    minimumSteadyStateSettleMilliseconds: 1000,
    maximumAbsoluteP95RegressionMilliseconds: 10,
    maximumRelativeP95RegressionRatio: 0.05,
    maximumSteadyRssP95DeltaBytes: 2 * 1024 * 1024
  };
  let verifier: BudgetModule;

  before(async () => {
    verifier = await import(pathToFileURL(script).href) as BudgetModule;
  });

  it("freezes the documented p95/RSS release thresholds in the shared budget file", () => {
    const configured = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, "scripts", "build-budgets.json"),
      "utf8"
    )) as { jsonOnlyExtensionHost: ActivationBudget };
    assert.deepStrictEqual(configured.jsonOnlyExtensionHost, budget);
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.strictEqual(
      manifest.scripts["verify:json-only-extension-host-budget"],
      "node scripts/verify-json-only-activation-budget.mjs"
    );
  });

  it("compares installable baseline and combined-production reports", () => {
    const baseline = report({ activationP95: 100, steadyRssP95: 200_000_000 });
    const candidate = report({
      activationP95: 109,
      steadyRssP95: 202_000_000,
      artifactKind: "combined-vsix"
    });
    const comparison = verifier.compareJsonOnlyActivationReports(baseline, candidate, budget);
    assert.strictEqual(comparison.comparison.activationRegressionMilliseconds, 9);
    assert.strictEqual(comparison.comparison.activationAllowanceMilliseconds, 10);
    assert.strictEqual(comparison.comparison.steadyRssP95DeltaBytes, 2_000_000);
    assert.ok(Object.values(comparison.gates).every(Boolean));
    assert.strictEqual(comparison.passed, true);
  });

  it("uses five percent when it exceeds the ten millisecond floor and fails either regression", () => {
    const baseline = report({ activationP95: 400, steadyRssP95: 200_000_000 });
    const candidate = report({
      activationP95: 421,
      steadyRssP95: 202_097_153,
      artifactKind: "combined-vsix"
    });
    const comparison = verifier.compareJsonOnlyActivationReports(baseline, candidate, budget);
    assert.strictEqual(comparison.comparison.activationAllowanceMilliseconds, 20);
    assert.strictEqual(comparison.gates.activationP95WithinBudget, false);
    assert.strictEqual(comparison.gates.steadyRssP95WithinBudget, false);
    assert.strictEqual(comparison.passed, false);
  });

  it("rejects stub/development evidence, too few samples, hard-condition failures, and non-combined candidates", () => {
    const baseline = report({ activationP95: 100, steadyRssP95: 200_000_000 });
    const candidate = report({
      activationP95: 100,
      steadyRssP95: 200_000_000,
      artifactKind: "combined-vsix"
    });
    const developmentBaseline = structuredClone(baseline);
    (developmentBaseline.scope as { artifactKind: string }).artifactKind = "extension-directory";
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(developmentBaseline, candidate, budget),
      /installable VSIX/
    );
    const tooFew = structuredClone(candidate);
    tooFew.input.iterations = 19;
    tooFew.summary.successfulSamples = 19;
    tooFew.samples = tooFew.samples.slice(0, 19);
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, tooFew, budget),
      /at least 20/
    );
    const reusedHost = structuredClone(candidate);
    for (const sample of reusedHost.samples) {
      sample.extensionHost.pid = 1;
    }
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, reusedHost, budget),
      /distinct fresh Extension Host/
    );
    const forgedSummary = structuredClone(candidate);
    forgedSummary.summary.activationMilliseconds.p95 += 1;
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, forgedSummary, budget),
      /recomputed from raw samples/
    );
    const shortSettle = structuredClone(candidate);
    shortSettle.input.settleMilliseconds = 999;
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, shortSettle, budget),
      /at least 1000 ms/
    );
    const violated = structuredClone(candidate);
    violated.hardConditions.passed = false;
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, violated, budget),
      /hard conditions/
    );
    const directoryCandidate = structuredClone(candidate);
    directoryCandidate.scope.isCombinedVsix = false;
    directoryCandidate.scope.artifactKind = "vsix";
    assert.throws(
      () => verifier.compareJsonOnlyActivationReports(baseline, directoryCandidate, budget),
      /combined production VSIX/
    );
  });

  it("strictly parses default and explicit report paths", () => {
    const defaults = verifier.parseJsonOnlyActivationBudgetArguments([]);
    assert.strictEqual(
      path.relative(repositoryRoot, defaults.baselineFile).replaceAll("\\", "/"),
      verifier.defaultJsonOnlyActivationBudgetInputs.baseline
    );
    const explicit = verifier.parseJsonOnlyActivationBudgetArguments([
      "--baseline=dist/measurements/base.json",
      "--candidate", "dist/measurements/candidate.json",
      "--out", "dist/measurements/result.json"
    ]);
    assert.ok(explicit.candidateFile.endsWith(path.join("dist", "measurements", "candidate.json")));
    assert.throws(
      () => verifier.parseJsonOnlyActivationBudgetArguments(["--candidate"]),
      /Missing path/
    );
    assert.throws(
      () => verifier.parseJsonOnlyActivationBudgetArguments(["--unknown", "x"]),
      /Unknown JSON-only activation budget argument/
    );
    assert.throws(
      () => verifier.parseJsonOnlyActivationBudgetArguments([
        "--baseline", "same.json",
        "--candidate", "same.json"
      ]),
      /must be distinct/
    );
  });

  it("verifies the measured bytes and actual combined production VSIX contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-activation-budget-"));
    try {
      const candidate = path.join(root, "candidate.vsix");
      await writeVsix(candidate, false);
      const bytes = fs.readFileSync(candidate);
      const evidence = {
        input: {
          artifact: candidate,
          artifactBytes: bytes.length,
          artifactSha256: createHash("sha256").update(bytes).digest("hex")
        }
      };
      const verified = await verifier.verifyMeasuredVsix(evidence, "candidate", true);
      assert.strictEqual(verified.combinedProduction, true);
      assert.strictEqual(verified.sha256, evidence.input.artifactSha256);

      const development = path.join(root, "development.vsix");
      await writeVsix(development, true);
      const developmentBytes = fs.readFileSync(development);
      await assert.rejects(
        () => verifier.verifyMeasuredVsix({
          input: {
            artifact: development,
            artifactBytes: developmentBytes.length,
            artifactSha256: createHash("sha256").update(developmentBytes).digest("hex")
          }
        }, "candidate", true),
        /must not contain JavaScript source maps/
      );
      await assert.rejects(
        () => verifier.verifyMeasuredVsix({
          input: { ...evidence.input, artifactSha256: "0".repeat(64) }
        }, "candidate", true),
        /no longer match/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

async function writeVsix(fileName: string, includeSourceMap: boolean): Promise<void> {
  const yazl = moduleRequire("yazl") as { ZipFile: new () => YazlZipFile };
  const zip = new yazl.ZipFile();
  for (const entryPath of [
    "extension/package.json",
    "extension/bundle/extension.js",
    "extension/bundle/features/rsglHost.js",
    "extension/bundle/rsgl/server.js",
    "extension/bundle/rsgl/worker.js",
    "extension/bundle/model-preview.js",
    ...(includeSourceMap ? ["extension/bundle/extension.js.map"] : [])
  ]) {
    zip.addBuffer(Buffer.from(entryPath), entryPath);
  }
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(fileName);
    zip.outputStream.pipe(output);
    zip.outputStream.on("error", reject);
    output.on("error", reject);
    output.on("close", resolve);
    zip.end();
  });
}

function report(options: {
  activationP95: number;
  steadyRssP95: number;
  artifactKind?: "vsix" | "combined-vsix";
}) {
  const artifactKind = options.artifactKind ?? "vsix";
  const samples = Array.from({ length: 20 }, (_, iteration) => ({
    schemaVersion: 1,
    adapter: "extension-host",
    iteration,
    status: "ok",
    extensionHost: {
      pid: 1000 + iteration,
      node: "v22.0.0",
      platform: "win32",
      arch: "x64",
      vscodeVersion: "1.109.0"
    },
    activationMilliseconds: options.activationP95,
    rssBeforeBytes: options.steadyRssP95 - 1024,
    rssAfterActivationBytes: options.steadyRssP95,
    steadyRssBytes: options.steadyRssP95,
    rssDeltaBytes: 1024,
    installedHooks: [
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
    ],
    moduleLoads: [],
    processSpawns: [],
    workerSpawns: [],
    filesystemWalks: [],
    watcherRegistrations: [],
    instrumentationWarnings: []
  }));
  return {
    schemaVersion: 1,
    measurement: "json-only-activation",
    scope: {
      adapter: "extension-host",
      isExtensionHost: true,
      isCombinedVsix: artifactKind === "combined-vsix",
      artifactKind
    },
    input: {
      artifact: `${artifactKind}.vsix`,
      artifactBytes: 1024,
      artifactSha256: (artifactKind === "combined-vsix" ? "b" : "a").repeat(64),
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
        consistent: true,
        distinctProcessCount: 20
      }
    },
    summary: {
      successfulSamples: 20,
      failedSamples: 0,
      activationMilliseconds: { p95: options.activationP95 },
      steadyRssBytes: { p95: options.steadyRssP95 }
    },
    hardConditions: {
      rsglModuleLoadsZero: true,
      rsglProcessSpawnAttemptsZero: true,
      rsglWorkerSpawnAttemptsZero: true,
      rsglFilesystemWalksZero: true,
      rsglWatcherRegistrationsZero: true,
      instrumentationWarningsZero: true,
      counts: {
        rsglModuleLoads: 0,
        rsglProcessSpawnAttempts: 0,
        rsglWorkerSpawnAttempts: 0,
        extensionOwnedNonRsglProcessSpawns: 0,
        hostProcessSpawnNoise: 0,
        rsglFilesystemWalks: 0,
        rsglWatcherRegistrations: 0,
        instrumentationWarnings: 0
      },
      passed: true
    },
    valid: true,
    samples
  };
}
