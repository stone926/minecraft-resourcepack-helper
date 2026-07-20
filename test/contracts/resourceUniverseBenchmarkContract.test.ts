import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface BenchmarkProfile {
  name: string;
  multiRootProjectCount: number;
  physicalProducerCount: number;
  physicalEdgeCount: number;
  zipEntryCount: number;
}

interface BenchmarkModule {
  defaultResourceUniverseBenchmarkOutput: string;
  resourceUniverseBenchmarkProfiles: Record<"default" | "smoke", BenchmarkProfile>;
  resourceUniverseBenchmarkScenarioIds: readonly string[];
  parseResourceUniverseBenchmarkArguments(args: string[]): {
    profileName: string;
    outputPath: string;
    help: boolean;
    commandArguments: readonly string[];
  };
  resolveResourceUniverseBenchmarkOutput(repositoryRoot: string, outputPath: string): {
    outputFile: string;
  };
  detectResourceUniverseBenchmarkRuntime(): {
    kind: "windows" | "wsl" | "posix";
    isWslRuntime: boolean;
    wslDistroName: string | null;
    wslInteropPresent: boolean;
  };
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
    runtime: ReturnType<BenchmarkModule["detectResourceUniverseBenchmarkRuntime"]>;
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

describe("resource-universe benchmark contract", () => {
  const repositoryRoot = process.cwd();
  const script = path.join(repositoryRoot, "scripts", "resource-universe-benchmark.mjs");
  let benchmark: BenchmarkModule;

  before(async () => {
    benchmark = await import(pathToFileURL(script).href) as BenchmarkModule;
  });

  it("freezes release-scale defaults instead of treating smoke counts as evidence", () => {
    const profile = benchmark.resourceUniverseBenchmarkProfiles.default;
    assert.ok(profile.multiRootProjectCount >= 2);
    assert.ok(profile.physicalProducerCount >= 20_000);
    assert.ok(profile.physicalEdgeCount >= 20_000);
    assert.ok(profile.zipEntryCount >= 5_000);
    assert.ok(benchmark.resourceUniverseBenchmarkProfiles.smoke.physicalProducerCount
      < profile.physicalProducerCount);
    assert.deepStrictEqual(benchmark.resourceUniverseBenchmarkScenarioIds, [
      "platform-path-canonicalization",
      "multi-root-project-cache",
      "synthetic-vscode-remote-project-discovery",
      "large-pack-resource-universe",
      "extraction-free-zip"
    ]);
  });

  it("strictly parses --smoke/--out and confines reports to dist/measurements", () => {
    assert.deepStrictEqual(benchmark.parseResourceUniverseBenchmarkArguments([]), {
      profileName: "default",
      outputPath: "dist/measurements/resource-universe-benchmark.json",
      help: false,
      commandArguments: []
    });
    assert.deepStrictEqual(
      benchmark.parseResourceUniverseBenchmarkArguments([
        "--smoke",
        "--out=dist/measurements/路径 with spaces/report.json"
      ]),
      {
        profileName: "smoke",
        outputPath: "dist/measurements/路径 with spaces/report.json",
        help: false,
        commandArguments: ["--smoke", "--out=dist/measurements/路径 with spaces/report.json"]
      }
    );
    assert.throws(
      () => benchmark.parseResourceUniverseBenchmarkArguments(["--smoke", "--smoke"]),
      /only be specified once/
    );
    assert.throws(
      () => benchmark.parseResourceUniverseBenchmarkArguments(["--out"]),
      /Missing path/
    );
    assert.throws(
      () => benchmark.parseResourceUniverseBenchmarkArguments(["--unknown"]),
      /Unknown resource-universe benchmark argument/
    );
    assert.throws(
      () => benchmark.resolveResourceUniverseBenchmarkOutput(
        repositoryRoot,
        "dist/outside-measurements/report.json"
      ),
      /must stay inside/
    );
    assert.throws(
      () => benchmark.resolveResourceUniverseBenchmarkOutput(
        repositoryRoot,
        "dist/measurements/report.txt"
      ),
      /must be a JSON file/
    );
  });

  it("labels the real host runtime independently from the synthetic remote URI scenario", () => {
    const runtime = benchmark.detectResourceUniverseBenchmarkRuntime();
    assert.strictEqual(runtime.isWslRuntime, runtime.kind === "wsl");
    if (process.platform === "win32") {
      assert.strictEqual(runtime.kind, "windows");
      assert.strictEqual(runtime.isWslRuntime, false);
    }
  });

  it("runs all five smoke scenarios and emits scoped machine-readable evidence", function () {
    this.timeout(60_000);
    const measurementsRoot = path.join(repositoryRoot, "dist", "measurements");
    fs.mkdirSync(measurementsRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(measurementsRoot, "benchmark-contract-"));
    const outputFile = path.join(temporaryRoot, "smoke 路径.json");
    const relativeOutput = path.relative(repositoryRoot, outputFile);
    try {
      const result = spawnSync(process.execPath, [script, "--smoke", "--out", relativeOutput], {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true
      });

      assert.strictEqual(result.status, 0, result.stderr);
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

  it("exposes the canonical build-then-benchmark package command", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.strictEqual(
      manifest.scripts["benchmark:resource-universe"],
      "node scripts/build.mjs all --typecheck-only && node scripts/resource-universe-benchmark.mjs"
    );
  });
});
