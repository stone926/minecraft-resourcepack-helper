import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../helpers/testProcess";

interface BenchmarkModule {
  resourceUniverseBenchmarkScenarioIds: readonly string[];
}

interface Distribution {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

interface BenchmarkScenario {
  id: string;
  status: string;
  synthetic: boolean;
  measurements: Record<string, Distribution>;
  counts: Record<string, number>;
  evidence: Record<string, unknown>;
}

interface BenchmarkReport {
  schemaVersion: number;
  measurement: string;
  status: string;
  commit: { sha: string | null; dirty: boolean | null };
  environment: {
    platform: string;
    node: string;
    processRssAtEndBytes: number;
    runtime: {
      kind: "windows" | "wsl" | "posix";
      isWslRuntime: boolean;
      wslDistroName: string | null;
      wslInteropPresent: boolean;
    };
  };
  command: { argv: string[]; display: string; profile: string; output: string };
  scope: {
    syntheticVscodeRemoteUriHost: boolean;
    realRemoteExtensionHost: boolean;
    realWslRuntime: boolean;
    realWslFilesystemFixture: boolean;
    requestedScale: {
      multiRootProjects: number;
      physicalProducers: number;
      physicalEdges: number;
      zipEntries: number;
    };
  };
  limitations: string[];
  compiledInputs: Record<string, { path: string; bytes: number; sha256: string }>;
  scenarios: BenchmarkScenario[];
}

describe("resource-universe benchmark smoke", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  const repositoryRoot = process.cwd();
  const script = path.join(repositoryRoot, "scripts", "resource-universe-benchmark.mjs");
  let benchmark: BenchmarkModule;

  before(async () => {
    benchmark = await import(pathToFileURL(script).href) as BenchmarkModule;
  });

  it("runs all five scenarios and emits scoped machine-readable evidence", () => {
    const measurementsRoot = path.join(repositoryRoot, "dist", "measurements");
    fs.mkdirSync(measurementsRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(measurementsRoot, "benchmark-contract-"));
    const outputFile = path.join(temporaryRoot, "smoke 路径.json");
    const relativeOutput = path.relative(repositoryRoot, outputFile);
    try {
      const result = runTestProcessSync(
        process.execPath,
        [script, "--smoke", "--out", relativeOutput],
        { cwd: repositoryRoot }
      );

      assertTestProcessStatus(result);
      assert.strictEqual(result.stderr, "");
      assert.match(result.stdout, /Profile: smoke/);
      const raw = fs.readFileSync(outputFile, "utf8");
      const report = JSON.parse(raw) as BenchmarkReport;
      assert.strictEqual(report.schemaVersion, 1);
      assert.strictEqual(report.measurement, "resource-universe-platform-and-scale");
      assert.strictEqual(report.status, "completed");
      assert.ok(report.commit.sha === null || /^[0-9a-f]{40}$/.test(report.commit.sha));
      assert.strictEqual(report.environment.platform, process.platform);
      assert.strictEqual(report.environment.node, process.version);
      assert.ok(report.environment.processRssAtEndBytes > 0);
      assert.strictEqual(report.command.profile, "smoke");
      assert.ok(report.command.argv.includes("--smoke"));
      assert.ok(report.command.display.includes("resource-universe-benchmark.mjs"));
      assert.strictEqual(report.scope.syntheticVscodeRemoteUriHost, true);
      assert.strictEqual(report.scope.realRemoteExtensionHost, false);
      assert.strictEqual(report.scope.realWslRuntime, report.environment.runtime.isWslRuntime);
      assert.strictEqual(report.scope.realWslFilesystemFixture, report.environment.runtime.isWslRuntime);
      assert.deepStrictEqual(report.scope.requestedScale, {
        multiRootProjects: 2,
        physicalProducers: 500,
        physicalEdges: 500,
        zipEntries: 100
      });
      assert.ok(report.limitations.some(limitation => /does not claim a real SSH/.test(limitation)));
      assert.strictEqual(Object.keys(report.compiledInputs).length, 5);
      assert.deepStrictEqual(
        report.scenarios.map(scenario => scenario.id),
        [...benchmark.resourceUniverseBenchmarkScenarioIds]
      );
      assert.ok(report.scenarios.every(scenario => scenario.status === "measured"));
      for (const scenario of report.scenarios) {
        for (const distribution of Object.values(scenario.measurements)) {
          assert.ok(distribution.samples > 0);
          assert.ok(Number.isFinite(distribution.p50));
          assert.ok(Number.isFinite(distribution.p95));
          assert.ok(distribution.p95 >= distribution.p50);
          assert.ok(distribution.max >= distribution.p95);
        }
      }

      const remote = report.scenarios.find(scenario =>
        scenario.id === "synthetic-vscode-remote-project-discovery"
      );
      assert.strictEqual(remote?.synthetic, true);
      assert.strictEqual(remote?.counts.nativePathSidecars, 0);
      assert.strictEqual(remote?.evidence.realRemoteExtensionHost, false);
      assert.match(String(remote?.evidence.claim), /not an SSH\/WSL\/Dev Container/);

      const multiRoot = report.scenarios.find(scenario => scenario.id === "multi-root-project-cache");
      assert.strictEqual(multiRoot?.counts.projectCount, 2);
      assert.strictEqual(multiRoot?.counts.warmStatCalls, 0);
      assert.strictEqual(multiRoot?.evidence.invalidatedProjectsPerTargetedEvent, 1);

      const largePack = report.scenarios.find(scenario => scenario.id === "large-pack-resource-universe");
      assert.strictEqual(largePack?.counts.physicalProducers, 500);
      assert.strictEqual(largePack?.counts.physicalEdges, 500);
      assert.ok((largePack?.counts.snapshotBytes ?? 0) > 0);
      assert.ok((largePack?.counts.peakObservedRssBytes ?? 0) > 0);

      const zip = report.scenarios.find(scenario => scenario.id === "extraction-free-zip");
      assert.strictEqual(zip?.counts.archiveEntries, 100);
      assert.strictEqual(zip?.counts.extractedFiles, 0);
      assert.strictEqual(zip?.evidence.temporaryExtractionDirectoryCreated, false);

      const platform = report.scenarios.find(scenario => scenario.id === "platform-path-canonicalization");
      assert.strictEqual(platform?.evidence.windowsDriveCaseApplicable, process.platform === "win32");
      if (process.platform === "win32") {
        assert.strictEqual(platform?.evidence.windowsDriveCaseIdentityEquivalent, true);
      }

      assert.doesNotMatch(raw, /"passed"\s*:/i);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
