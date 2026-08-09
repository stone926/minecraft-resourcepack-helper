import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface MeasurementPaths {
  repositoryRoot: string;
  measurementsRoot: string;
  outputDirectory: string;
  developmentArtifact: string;
  productionArtifact: string;
  reportFile: string;
}

interface MeasurementStep {
  id: string;
  script: string;
  args: readonly string[];
  captureMode?: "development" | "production";
}

interface MeasurementModule {
  parseCombinedVsixMeasurementArguments(args: string[]): { outputDirectory: string };
  resolveCombinedVsixMeasurementPaths(options: {
    repositoryRoot: string;
    outputDirectory?: string;
  }): MeasurementPaths;
  createCombinedVsixMeasurementPlan(paths: MeasurementPaths): readonly MeasurementStep[];
}

interface ReportModule {
  combinedVsixRuntimeEntries: Record<string, string>;
  combinedVsixRuntimeSourceMaps: readonly string[];
  semanticJsonHash(value: unknown): string;
  createCombinedVsixReport(input: TestComparisonInput): CombinedReport;
}

interface BudgetModule {
  mainVsixBudgetEntryIds: readonly string[];
  readBuildBudgetConfiguration(fileName?: string): Record<string, unknown>;
  parseBuildBudgetConfiguration(value: unknown): Record<string, unknown>;
}

interface ArchiveModule {
  readVsixArchiveMetrics(fileName: string, options?: {
    captureEntry?: (entryPath: string) => boolean;
    limits?: { maximumEntries?: number };
  }): Promise<{
    archiveBytes: number;
    compressedEntriesBytes: number;
    installedBytes: number;
    fileCount: number;
    capturedEntries: Record<string, Buffer>;
  }>;
}

interface EvidenceModule {
  vsceArchivePathForStagePath(stagePath: string): string;
}

interface YazlZipFile {
  addBuffer(bytes: Buffer, fileName: string): void;
  end(): void;
  outputStream: NodeJS.ReadableStream;
}

interface CombinedReport {
  schemaVersion: number;
  comparison: {
    checks: Record<string, boolean>;
    entries: Record<string, { delta: Record<string, number> }>;
    jsonWhitespace: { savingsBytes: number };
    sourceMaps: {
      savings: { rawBytes: number; vsixCompressedBytes: number; installedBytes: number };
      production: { generatedRawBytes: number };
    };
    sizeAttribution: {
      sourceMapExclusion: { rawBytes: number; vsixCompressedBytes: number; installedBytes: number };
      vsceGeneratedMetadata: { vsixCompressedBytes: number; installedBytes: number };
      compressedEntriesBytes: number;
      installedBytes: number;
      zipStructuralOverheadBytes: number;
    };
  };
  budgetEvaluation: {
    status: string;
    source: string;
    schemaVersion: number;
    passed: boolean;
    configured: {
      archiveBytes: number;
      runtimeEntryCompressedBytes: Record<string, number>;
    };
    measured: {
      archiveBytes: number;
      runtimeEntryCompressedBytes: Record<string, number>;
    };
    headroom: {
      archiveBytes: number;
      runtimeEntryCompressedBytes: Record<string, number>;
    };
    checks: {
      archiveBytes: boolean;
      runtimeEntryCompressedBytes: Record<string, boolean>;
    };
  };
}

interface TestRuntimeEntry {
  path: string;
  rawBytes: number;
  vsixCompressedBytes: number;
  installedBytes: number;
  sha256: string;
}

interface TestModeEvidence {
  mode: "development" | "production";
  commit: string;
  toolchainFingerprint: string;
  runtimeVerification: { script: string; arguments: string[]; passed: boolean };
  artifact: Record<string, string | number>;
  stage: {
    contentHash: string;
    manifestSha256: string;
    paths: string[];
    files: Array<{ path: string; bytes: number; sha256: string }>;
    vscodeIgnore: { bytes: number; sha256: string; lines: string[] };
  };
  manifest: { value: Record<string, unknown>; semanticHash: string };
  runtimeEntries: Record<string, TestRuntimeEntry>;
  sourceMaps: {
    files: Array<{
      path: string;
      rawBytes: number;
      sha256: string;
      packaged: boolean;
      vsixCompressedBytes: number;
      installedBytes: number;
    }>;
  };
  jsonAssets: {
    files: Array<{
      path: string;
      bytes: number;
      semanticHash: string;
      contentSha256: string;
      compactSha256: string;
      compactBytes: number;
      vsixCompressedBytes: number;
      installedBytes: number;
    }>;
  };
  vsceMetadata: {
    files: Array<{ path: string; vsixCompressedBytes: number; installedBytes: number }>;
  };
  archivePaths: string[];
}

interface TestComparisonInput {
  repository: { commit: string; tree: string; commitTimestamp: string; clean: boolean };
  toolchain: { node: string; fingerprint: string };
  budgetConfiguration: {
    source: string;
    schemaVersion: number;
    mainVsix: {
      archiveBytes: number;
      compressedEntriesBytes: number;
      installedBytes: number;
      fileCount: number;
      runtimeEntryCompressedBytes: Record<string, number>;
    };
  };
  development: TestModeEvidence;
  production: TestModeEvidence;
}

describe("combined VSIX artifact measurement", () => {
  let measurement: MeasurementModule;
  let reportModule: ReportModule;
  let budgetModule: BudgetModule;
  let archiveModule: ArchiveModule;
  let evidenceModule: EvidenceModule;

  before(async () => {
    const scripts = path.join(process.cwd(), "scripts");
    measurement = await import(pathToFileURL(path.join(
      scripts,
      "measure-combined-vsix.mjs"
    )).href) as MeasurementModule;
    reportModule = await import(pathToFileURL(path.join(
      scripts,
      "combined-vsix-report.mjs"
    )).href) as ReportModule;
    budgetModule = await import(pathToFileURL(path.join(
      scripts,
      "verify-build-budgets.mjs"
    )).href) as BudgetModule;
    archiveModule = await import(pathToFileURL(path.join(
      scripts,
      "vsix-archive-metrics.mjs"
    )).href) as ArchiveModule;
    evidenceModule = await import(pathToFileURL(path.join(
      scripts,
      "combined-vsix-evidence.mjs"
    )).href) as EvidenceModule;
  });

  it("creates one typecheck and one official build/stage/package pass per bundle mode", () => {
    const repositoryRoot = path.resolve("fixture 工作区 with spaces", "minecraft-helper");
    const parsed = measurement.parseCombinedVsixMeasurementArguments([
      "--output-dir",
      "dist/measurements/对照 evidence"
    ]);
    const paths = measurement.resolveCombinedVsixMeasurementPaths({ repositoryRoot, ...parsed });
    const plan = measurement.createCombinedVsixMeasurementPlan(paths);

    assert.strictEqual(plan.filter(step => step.id === "typecheck").length, 1);
    assert.deepStrictEqual(commands(plan), [
      ["scripts/build.mjs", "main", "--typecheck-only"],
      ["scripts/build.mjs", "main", "--bundle-only", "--bundle-mode", "development"],
      ["scripts/assemble-main-vsix-stage.mjs", "--bundle-mode", "development"],
      ["scripts/package-vsix.mjs", "main", "--out", paths.developmentArtifact],
      [
        "scripts/verify-main-vsix.mjs",
        paths.developmentArtifact,
        "--comparison-development"
      ],
      ["scripts/build.mjs", "main", "--bundle-only", "--bundle-mode", "production"],
      ["scripts/assemble-main-vsix-stage.mjs", "--bundle-mode", "production"],
      ["scripts/package-vsix.mjs", "main", "--out", paths.productionArtifact],
      ["scripts/verify-main-vsix.mjs", paths.productionArtifact]
    ]);
    assert.strictEqual(plan[4].captureMode, "development");
    assert.strictEqual(plan[8].captureMode, "production");
    assert.ok(paths.developmentArtifact.endsWith("combined-unminified.vsix"));
    assert.ok(paths.productionArtifact.endsWith("combined-production.vsix"));
    assert.ok(paths.reportFile.endsWith("combined-vsix-comparison.json"));
    assert.throws(
      () => measurement.resolveCombinedVsixMeasurementPaths({
        repositoryRoot,
        outputDirectory: "dist/outside-measurements"
      }),
      /must stay inside/
    );
  });

  it("uses the report evaluator as the single frozen VSIX budget path", () => {
    const verifier = fs.readFileSync(
      path.join(process.cwd(), "scripts", "verify-build-budgets.mjs"),
      "utf8"
    );
    assert.ok(verifier.includes("evaluateFrozenMainVsixBudget"));
    assert.strictEqual(verifier.includes("assertFrozenArtifactBudget"), false);
  });

  it("keeps measurement pipeline defaults in one path catalog", () => {
    const scriptsRoot = path.join(process.cwd(), "scripts");
    const catalog = fs.readFileSync(path.join(scriptsRoot, "measurement-paths.mjs"), "utf8");
    assert.ok(catalog.includes('measurementsDirectory = "dist/measurements"'));
    assert.ok(catalog.includes("combined-vsix-artifact-names.mjs"));
    assert.strictEqual(catalog.includes("combined-vsix-layout.mjs"), false);
    assert.strictEqual(catalog.includes("build-bundles.mjs"), false);
    for (const script of [
      "measure-combined-vsix.mjs",
      "measure-json-only-activation.mjs",
      "measure-json-only-activation-comparison.mjs",
      "resource-universe-benchmark.mjs",
      "verify-json-only-activation-budget.mjs",
      "verify-json-only-activation-comparison.mjs"
    ]) {
      const source = fs.readFileSync(path.join(scriptsRoot, script), "utf8");
      assert.ok(source.includes("measurementPaths") || source.includes("measurementsDirectory"));
      assert.strictEqual(source.includes('"dist/measurements'), false, script);
    }
  });

  it("strictly parses output arguments without a dirty-build escape hatch", () => {
    assert.deepStrictEqual(measurement.parseCombinedVsixMeasurementArguments([]), {
      outputDirectory: "dist/measurements"
    });
    assert.deepStrictEqual(
      measurement.parseCombinedVsixMeasurementArguments(["--output-dir=dist/measurements/run one"]),
      { outputDirectory: "dist/measurements/run one" }
    );
    assert.throws(
      () => measurement.parseCombinedVsixMeasurementArguments(["--output-dir"]),
      /Missing path/
    );
    assert.throws(
      () => measurement.parseCombinedVsixMeasurementArguments([
        "--output-dir", "dist/measurements/a", "--output-dir", "dist/measurements/b"
      ]),
      /only be specified once/
    );
    assert.throws(
      () => measurement.parseCombinedVsixMeasurementArguments(["--allow-dirty"]),
      /Unknown combined VSIX measurement argument/
    );
  });

  it("models only VSCE's canonical root-file name rewrites", () => {
    assert.strictEqual(
      evidenceModule.vsceArchivePathForStagePath("CHANGELOG.md"),
      "extension/changelog.md"
    );
    assert.strictEqual(
      evidenceModule.vsceArchivePathForStagePath("README.md"),
      "extension/readme.md"
    );
    assert.strictEqual(
      evidenceModule.vsceArchivePathForStagePath("LICENSE"),
      "extension/LICENSE.txt"
    );
    assert.strictEqual(
      evidenceModule.vsceArchivePathForStagePath("README_CN.md"),
      "extension/README_CN.md"
    );
    assert.strictEqual(
      evidenceModule.vsceArchivePathForStagePath("bundle/Extension.js"),
      "extension/bundle/Extension.js"
    );
  });

  it("publishes the measurement command without replacing the Extension Host benchmark", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert.strictEqual(
      manifest.scripts?.["measure:combined-vsix"],
      "node scripts/measure-combined-vsix.mjs"
    );
    assert.strictEqual(
      manifest.scripts?.["benchmark:json-only-extension-host"],
      "node scripts/measure-json-only-activation-comparison.mjs"
    );
  });

  it("attributes five entry deltas, source-map exclusion, and semantic JSON whitespace savings", () => {
    const input = createComparisonInput();
    const report = reportModule.createCombinedVsixReport(input);

    assert.strictEqual(report.comparison.checks.productionEntriesAllSmaller, true);
    assert.strictEqual(report.comparison.checks.noNestedOrCompanionVsixPath, true);
    assert.strictEqual(report.comparison.checks.nonOptimizedStageFilesEquivalent, true);
    assert.strictEqual(Object.keys(report.comparison.entries).length, 5);
    assert.strictEqual(report.comparison.entries.root.delta.rawBytes, 40);
    assert.strictEqual(report.comparison.entries.root.delta.vsixCompressedBytes, 20);
    assert.strictEqual(report.comparison.entries.root.delta.installedBytes, 40);
    assert.ok(report.comparison.jsonWhitespace.savingsBytes > 0);
    assert.deepStrictEqual(report.comparison.sourceMaps.savings, {
      fileCount: 5,
      rawBytes: 50,
      vsixCompressedBytes: 25,
      installedBytes: 50
    });
    assert.strictEqual(report.comparison.sourceMaps.production.generatedRawBytes, 30);
    assert.strictEqual(report.comparison.sizeAttribution.sourceMapExclusion.rawBytes, 50);
    assert.strictEqual(report.comparison.sizeAttribution.vsceGeneratedMetadata.installedBytes, 10);
    assert.ok(report.comparison.sizeAttribution.zipStructuralOverheadBytes > 0);
    assert.strictEqual(report.schemaVersion, 2);
    assert.strictEqual(report.budgetEvaluation.status, "frozen-release-budgets-pass");
    assert.strictEqual(report.budgetEvaluation.source, "scripts/build-budgets.json");
    assert.strictEqual(report.budgetEvaluation.schemaVersion, 2);
    assert.strictEqual(report.budgetEvaluation.passed, true);
    assert.strictEqual(report.budgetEvaluation.configured.archiveBytes, 750);
    assert.strictEqual(report.budgetEvaluation.measured.archiveBytes, 700);
    assert.strictEqual(report.budgetEvaluation.headroom.archiveBytes, 50);
    assert.strictEqual(report.budgetEvaluation.checks.archiveBytes, true);
    assert.deepStrictEqual(
      Object.keys(report.budgetEvaluation.measured.runtimeEntryCompressedBytes).sort(),
      ["modelPreview", "root", "rsglHost", "server", "worker"]
    );
  });

  it("rejects capability drift, a second VSIX path, and any non-smaller production entry", () => {
    const unverifiedDevelopmentMaps = createComparisonInput();
    unverifiedDevelopmentMaps.development.runtimeVerification.arguments = [];
    assert.throws(
      () => reportModule.createCombinedVsixReport(unverifiedDevelopmentMaps),
      /did not pass the canonical packaged runtime smoke/
    );

    const entryRegression = createComparisonInput();
    entryRegression.production.runtimeEntries.root.vsixCompressedBytes = 60;
    assert.throws(
      () => reportModule.createCombinedVsixReport(entryRegression),
      /root vsixCompressedBytes must be smaller/
    );

    const nestedVsix = createComparisonInput();
    (nestedVsix.production.archivePaths as string[]).push("extension/legacy/rsgl.vsix");
    (nestedVsix.production.archivePaths as string[]).sort();
    assert.throws(
      () => reportModule.createCombinedVsixReport(nestedVsix),
      /forbidden second VSIX/
    );

    const manifestDrift = createComparisonInput();
    const manifest = (manifestDrift.production.manifest as {
      value: Record<string, unknown>;
      semanticHash: string;
    });
    manifest.value = { ...manifest.value, extensionPack: ["legacy.rsgl"] };
    manifest.semanticHash = reportModule.semanticJsonHash(manifest.value);
    assert.throws(
      () => reportModule.createCombinedVsixReport(manifestDrift),
      /publish manifests differ/
    );

    const unexplainedStageChange = createComparisonInput();
    const packageFile = unexplainedStageChange.production.stage.files.find(
      file => file.path === "package.json"
    );
    assert.ok(packageFile);
    packageFile.sha256 = "unexpected-package-change";
    assert.throws(
      () => reportModule.createCombinedVsixReport(unexplainedStageChange),
      /Non-optimized VSIX stage file changed/
    );

    const missingDevelopmentMap = createComparisonInput();
    missingDevelopmentMap.development.archivePaths = missingDevelopmentMap.development.archivePaths
      .filter(entryPath => entryPath !== `extension/${reportModule.combinedVsixRuntimeSourceMaps[0]}`);
    assert.throws(
      () => reportModule.createCombinedVsixReport(missingDevelopmentMap),
      /source-map paths do not match/
    );

    const exceededBudget = createComparisonInput();
    exceededBudget.budgetConfiguration.mainVsix.archiveBytes = 699;
    assert.throws(
      () => reportModule.createCombinedVsixReport(exceededBudget),
      /exceeds mainVsix\.archiveBytes: 700\/699/
    );

    const incompleteBudget = createComparisonInput();
    delete incompleteBudget.budgetConfiguration.mainVsix.runtimeEntryCompressedBytes.worker;
    assert.throws(
      () => reportModule.createCombinedVsixReport(incompleteBudget),
      /complete frozen main VSIX release budget/
    );

    const exactBudget = createComparisonInput();
    exactBudget.budgetConfiguration.mainVsix.archiveBytes = 700;
    const exactReport = reportModule.createCombinedVsixReport(exactBudget);
    assert.strictEqual(exactReport.budgetEvaluation.headroom.archiveBytes, 0);
    assert.strictEqual(exactReport.budgetEvaluation.checks.archiveBytes, true);

    const pendingBudget = createComparisonInput();
    pendingBudget.budgetConfiguration.mainVsix.archiveBytes = null as unknown as number;
    assert.throws(
      () => reportModule.createCombinedVsixReport(pendingBudget),
      /must be a frozen positive integer release budget/
    );
  });

  it("loads the reviewed formal VSIX budgets", () => {
    const budgets = budgetModule.readBuildBudgetConfiguration() as {
      schemaVersion: number;
      mainVsix: {
        archiveBytes: number;
        compressedEntriesBytes: number;
        installedBytes: number;
        fileCount: number;
        runtimeEntryCompressedBytes: Record<string, number>;
      };
    };
    assert.strictEqual(budgets.schemaVersion, 2);
    assert.deepStrictEqual(budgets.mainVsix, {
      archiveBytes: 1_000_000,
      compressedEntriesBytes: 985_000,
      installedBytes: 3_525_000,
      fileCount: 88,
      runtimeEntryCompressedBytes: {
        root: 103_000,
        rsglHost: 130_000,
        server: 255_000,
        worker: 183_000,
        modelPreview: 153_000
      }
    });
    assert.strictEqual(
      budgets.mainVsix.runtimeEntryCompressedBytes.root
        + budgets.mainVsix.runtimeEntryCompressedBytes.rsglHost,
      233_000,
      "moving RSGL implementation code must not relax the combined root/host allowance"
    );
    assert.deepStrictEqual(
      Object.keys(budgets.mainVsix.runtimeEntryCompressedBytes).sort(),
      [...budgetModule.mainVsixBudgetEntryIds].sort()
    );

    const invalid = structuredClone(budgets);
    delete invalid.mainVsix.runtimeEntryCompressedBytes.worker;
    assert.throws(
      () => budgetModule.parseBuildBudgetConfiguration(invalid),
      /must define/
    );
  });

  it("reads ZIP metadata without extraction and enforces bounded entry traversal", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-vsix-metrics-"));
    try {
      const archiveFile = path.join(temporaryRoot, "对照 archive.vsix");
      await writeZip(archiveFile, [
        ["extension/package.json", Buffer.from('{"name":"fixture"}')],
        ["extension/资源 space.txt", Buffer.from("payload")]
      ]);
      const metrics = await archiveModule.readVsixArchiveMetrics(archiveFile, {
        captureEntry: entryPath => entryPath === "extension/package.json"
      });
      assert.strictEqual(metrics.fileCount, 2);
      assert.ok(metrics.archiveBytes > metrics.compressedEntriesBytes);
      assert.strictEqual(metrics.installedBytes, Buffer.byteLength('{"name":"fixture"}') + 7);
      assert.strictEqual(
        metrics.capturedEntries["extension/package.json"].toString("utf8"),
        '{"name":"fixture"}'
      );
      await assert.rejects(
        archiveModule.readVsixArchiveMetrics(archiveFile, {
          limits: { maximumEntries: 1 }
        }),
        /entry safety limit/
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  function createComparisonInput(): TestComparisonInput {
    const manifest = {
      name: "minecraft-resourcepack-helper",
      publisher: "stone926",
      version: "2.3.3",
      main: "./bundle/extension.js",
      extensionKind: ["workspace"],
      contributes: { languages: [{ id: "rsgl" }] }
    };
    const compactJson = Buffer.from('{"title":"RSGL"}');
    const developmentJson = Buffer.from('{\n  "title": "RSGL"\n}\n');
    const jsonSemanticHash = reportModule.semanticJsonHash({ title: "RSGL" });
    const compactSha256 = sha256(compactJson);
    const productionStagePaths = [
      ".vscodeignore",
      ...Object.values(reportModule.combinedVsixRuntimeEntries),
      "package.json",
      "syntaxes/rsgl.tmLanguage.json"
    ].sort();
    const productionArchivePaths = [
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/package.json",
      "extension/syntaxes/rsgl.tmLanguage.json",
      ...Object.values(reportModule.combinedVsixRuntimeEntries).map(value => `extension/${value}`)
    ].sort();
    const developmentIgnore = Buffer.from("**/*.ts\n");
    const productionIgnore = Buffer.from("**/*.map\n**/*.ts\n");
    const runtimeCompressedDelta = 5 * 20;
    const runtimeInstalledDelta = 5 * 40;
    const jsonCompressedDelta = 12 - 8;
    const jsonInstalledDelta = developmentJson.length - compactJson.length;
    const sourceMapCompressedDelta = 5 * 5;
    const sourceMapInstalledDelta = 5 * 10;
    const vsceMetadataCompressedDelta = 5;
    const vsceMetadataInstalledDelta = 10;
    const compressedEntriesDelta = runtimeCompressedDelta
      + jsonCompressedDelta
      + sourceMapCompressedDelta
      + vsceMetadataCompressedDelta;
    const installedDelta = runtimeInstalledDelta
      + jsonInstalledDelta
      + sourceMapInstalledDelta
      + vsceMetadataInstalledDelta;
    const commit = "a".repeat(40);
    const toolchainIdentity = { node: "v24.0.0" };
    const toolchain = {
      ...toolchainIdentity,
      fingerprint: reportModule.semanticJsonHash(toolchainIdentity)
    };
    const makeEvidence = (mode: "development" | "production") => {
      const development = mode === "development";
      const stagePaths = development
        ? [...productionStagePaths, ...reportModule.combinedVsixRuntimeSourceMaps].sort()
        : [...productionStagePaths];
      const archivePaths = development
        ? [
          ...productionArchivePaths,
          ...reportModule.combinedVsixRuntimeSourceMaps.map(value => `extension/${value}`)
        ].sort()
        : [...productionArchivePaths];
      const runtimeEntries: Record<string, TestRuntimeEntry> = Object.fromEntries(
        Object.entries(reportModule.combinedVsixRuntimeEntries).map(([id, entryPath], index) => {
          const rawBytes = (development ? 140 : 100) + index;
          return [id, {
            path: entryPath,
            rawBytes,
            vsixCompressedBytes: (development ? 60 : 40) + index,
            installedBytes: rawBytes,
            sha256: `${mode}-${id}`
          }];
        })
      );
      const jsonBytes = development ? developmentJson : compactJson;
      const ignoreBytes = development ? developmentIgnore : productionIgnore;
      const sourceMaps = reportModule.combinedVsixRuntimeSourceMaps.map(entryPath => ({
        path: entryPath,
        rawBytes: development ? 10 : 6,
        sha256: `${mode}-${entryPath}-map`,
        packaged: development,
        vsixCompressedBytes: development ? 5 : 0,
        installedBytes: development ? 10 : 0
      }));
      const stageFiles = stagePaths.map(stagePath => {
        const runtime = Object.values(runtimeEntries).find(entry => entry.path === stagePath);
        if (runtime) {
          return { path: stagePath, bytes: runtime.rawBytes, sha256: runtime.sha256 };
        }
        const sourceMap = sourceMaps.find(file => file.path === stagePath);
        if (sourceMap) {
          return { path: stagePath, bytes: sourceMap.rawBytes, sha256: sourceMap.sha256 };
        }
        if (stagePath === "syntaxes/rsgl.tmLanguage.json") {
          return { path: stagePath, bytes: jsonBytes.length, sha256: sha256(jsonBytes) };
        }
        if (stagePath === ".vscodeignore") {
          return { path: stagePath, bytes: ignoreBytes.length, sha256: sha256(ignoreBytes) };
        }
        return { path: stagePath, bytes: 20, sha256: `unchanged-${stagePath}` };
      });
      return {
        mode,
        commit,
        toolchainFingerprint: toolchain.fingerprint,
        runtimeVerification: {
          script: "scripts/verify-main-vsix.mjs",
          arguments: development ? ["--comparison-development"] : [],
          passed: true
        },
        artifact: {
          fileName: development ? "combined-unminified.vsix" : "combined-production.vsix",
          sha256: `${mode}-archive`,
          archiveBytes: development ? 700 + compressedEntriesDelta + 300 : 700,
          compressedEntriesBytes: development ? 550 + compressedEntriesDelta : 550,
          installedBytes: development ? 1_500 + installedDelta : 1_500,
          fileCount: archivePaths.length
        },
        stage: {
          contentHash: `${mode}-stage`,
          manifestSha256: `${mode}-stage-manifest`,
          paths: [...stagePaths],
          files: stageFiles,
          vscodeIgnore: {
            bytes: ignoreBytes.length,
            sha256: sha256(ignoreBytes),
            lines: development ? ["**/*.ts"] : ["**/*.map", "**/*.ts"]
          }
        },
        manifest: {
          value: structuredClone(manifest),
          semanticHash: reportModule.semanticJsonHash(manifest)
        },
        runtimeEntries,
        sourceMaps: { files: sourceMaps },
        jsonAssets: {
          files: [{
            path: "syntaxes/rsgl.tmLanguage.json",
            bytes: jsonBytes.length,
            semanticHash: jsonSemanticHash,
            contentSha256: sha256(jsonBytes),
            compactSha256,
            compactBytes: compactJson.length,
            vsixCompressedBytes: development ? 12 : 8,
            installedBytes: jsonBytes.length
          }]
        },
        vsceMetadata: {
          files: [
            {
              path: "[Content_Types].xml",
              vsixCompressedBytes: development ? 30 : 25,
              installedBytes: development ? 60 : 50
            },
            {
              path: "extension.vsixmanifest",
              vsixCompressedBytes: 20,
              installedBytes: 40
            }
          ].sort((left, right) => left.path.localeCompare(right.path))
        },
        archivePaths: [...archivePaths]
      } satisfies TestModeEvidence;
    };
    return {
      repository: { commit, tree: "b".repeat(40), commitTimestamp: "1700000000", clean: true },
      toolchain,
      budgetConfiguration: {
        source: "scripts/build-budgets.json",
        schemaVersion: 2,
        mainVsix: {
          archiveBytes: 750,
          compressedEntriesBytes: 600,
          installedBytes: 1_600,
          fileCount: productionArchivePaths.length + 1,
          runtimeEntryCompressedBytes: Object.fromEntries(
            Object.keys(reportModule.combinedVsixRuntimeEntries).map(id => [id, 50])
          )
        }
      },
      development: makeEvidence("development"),
      production: makeEvidence("production")
    };
  }
});

async function writeZip(fileName: string, entries: Array<[string, Buffer]>): Promise<void> {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const yazl = require("yazl") as { ZipFile: new () => YazlZipFile };
  const zipFile = new yazl.ZipFile();
  for (const [entryPath, bytes] of entries) {
    zipFile.addBuffer(bytes, entryPath);
  }
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(fileName);
    output.on("error", reject);
    output.on("close", resolve);
    zipFile.outputStream.on("error", reject);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
}

function commands(plan: readonly MeasurementStep[]): string[][] {
  return plan.map(step => [step.script, ...step.args]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
