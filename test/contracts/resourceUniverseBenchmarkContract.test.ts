import * as assert from "node:assert/strict";
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
