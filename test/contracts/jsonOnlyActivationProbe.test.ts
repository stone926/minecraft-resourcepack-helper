import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ProbeModule {
  activationProbeAdapters: readonly string[];
  defaultActivationProbeOutputs: Record<string, string>;
  extensionHostRunnerProtocol: {
    version: number;
    requiredArguments: readonly string[];
    requirement: string;
  };
  parseActivationProbeArguments(args: string[]): Record<string, unknown>;
}

interface ExtensionHostSampleModule {
  parseExtensionHostSampleArguments(args: string[]): {
    artifact: string;
    extensionRoot: string;
    workspace: string;
    probeRunId: string;
    sampleId: string;
    artifactIdentity: { bytes: number; sha256: string };
    iteration: number;
    settleMilliseconds: number;
    sampleOutput: string;
  };
}

interface ProbeReport {
  schemaVersion: number;
  measurement: string;
  probeRunId: string;
  scope: {
    adapter: string;
    executionSurface: string;
    artifactKind: string;
    isExtensionHost: boolean;
    isCombinedVsix: boolean;
    claim: string;
    limitations: string[];
  };
  command: { argv: string[]; display: string };
  rawOutput: string;
  input: {
    artifactBytes: number;
    artifactSha256: string;
    iterations: number;
    workspace: string;
  };
  summary: {
    successfulSamples: number;
    failedSamples: number;
    distinctPidCount: number | null;
    distinctProcessInstanceCount: number | null;
    distinctSessionCount: number | null;
    pidReuseCount: number | null;
    activationMilliseconds: Distribution | null;
    steadyRssBytes: Distribution | null;
    rssDeltaBytes: Distribution | null;
    moduleLoads: Distribution | null;
    filesystemWalks: Distribution | null;
    watcherRegistrations: Distribution | null;
  };
  hardConditions: {
    rsglModuleLoadsZero: boolean;
    rsglProcessSpawnAttemptsZero: boolean;
    rsglWorkerSpawnAttemptsZero: boolean;
    rsglFilesystemWalksZero: boolean;
    mainWatcherRegistrationsPositive: boolean;
    rsglWatcherRegistrationsZero: boolean;
    instrumentationWarningsZero: boolean;
    counts: Record<string, number>;
    passed: boolean;
  };
  valid: boolean;
  samples: ProbeSample[];
}

interface Distribution {
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

interface ProbeSample {
  schemaVersion: number;
  adapter: string;
  probeRunId: string;
  sampleId: string;
  artifact: { bytes: number; sha256: string };
  iteration: number;
  status: "ok" | "error";
  error?: { name: string; code?: string; message: string };
  activationMilliseconds: number;
  rssBeforeBytes: number;
  rssAfterActivationBytes: number;
  steadyRssBytes: number;
  rssDeltaBytes: number;
  installedHooks: string[];
  moduleLoads: Array<{ request: string; resolved?: string; rsgl: boolean; durationMilliseconds?: number }>;
  processSpawns: Array<{ api: string; file: string; args: string[]; rsgl: boolean }>;
  workerSpawns: Array<{ api: string; file: string; rsgl: boolean }>;
  filesystemWalks: Array<{ api: string; target: string; recursive: boolean; rsgl: boolean }>;
  watcherRegistrations: Array<{ api: string; target: string; rsgl: boolean }>;
  instrumentationWarnings: Array<{ hook: string; message: string }>;
}

describe("JSON-only activation probe harness", () => {
  const repositoryRoot = process.cwd();
  const probeScript = path.join(repositoryRoot, "scripts", "measure-json-only-activation.mjs");
  const extensionHostSampleScript = path.join(
    repositoryRoot,
    "scripts",
    "activation-probe",
    "extension-host-sample.mjs"
  );
  let probe: ProbeModule;
  let extensionHostSample: ExtensionHostSampleModule;
  let temporaryRoots: string[] = [];

  before(async () => {
    probe = await import(pathToFileURL(probeScript).href) as ProbeModule;
    extensionHostSample = await import(pathToFileURL(extensionHostSampleScript).href) as ExtensionHostSampleModule;
  });

  afterEach(() => {
    for (const root of temporaryRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots = [];
  });

  it("measures a fresh Node process per sample without claiming Extension Host or combined VSIX data", () => {
    const fixture = createFixture();
    const bundle = writeFile(fixture.extensionRoot, "bundle/extension.js", [
      'const vscode = require("vscode");',
      "exports.activate = async context => {",
      '  const watcher = vscode.workspace.createFileSystemWatcher("**/*.json");',
      "  context.subscriptions.push(watcher);",
      '  await vscode.workspace.findFiles("**/*.json");',
      "};"
    ].join("\n"));
    const output = path.join(fixture.root, "raw", "node-bundle.json");
    const result = runProbe([
      "--adapter", "node-bundle",
      "--bundle", bundle,
      "--extension-root", fixture.extensionRoot,
      "--workspace", fixture.workspaceRoot,
      "--iterations", "3",
      "--settle-ms", "0",
      "--out", output
    ]);

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node bundle probe only/);
    const report = readJson<ProbeReport>(output);
    assert.strictEqual(report.schemaVersion, 3);
    assert.strictEqual(report.measurement, "json-only-activation");
    assert.match(report.probeRunId, /^[a-f0-9]{32}$/);
    assert.strictEqual(report.scope.adapter, "node-bundle");
    assert.strictEqual(report.scope.executionSurface, "fresh-node-process-with-vscode-api-stub");
    assert.strictEqual(report.scope.isExtensionHost, false);
    assert.strictEqual(report.scope.isCombinedVsix, false);
    assert.match(report.scope.claim, /not an installed extension.*combined VSIX/i);
    assert.ok(report.scope.limitations.some(value => value.includes("metafile")));
    assert.strictEqual(report.input.iterations, 3);
    assert.ok(report.input.artifactBytes > 0);
    assert.match(report.input.artifactSha256, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(report.command.argv.slice(0, 4), [
      "node",
      "scripts/measure-json-only-activation.mjs",
      "--adapter",
      "node-bundle"
    ]);

    assert.strictEqual(report.summary.successfulSamples, 3);
    assert.strictEqual(report.summary.failedSamples, 0);
    assert.strictEqual(report.summary.distinctPidCount, null);
    assert.strictEqual(report.summary.distinctProcessInstanceCount, null);
    assert.strictEqual(report.summary.distinctSessionCount, null);
    assert.strictEqual(report.summary.pidReuseCount, null);
    assert.ok((report.summary.activationMilliseconds?.p95 ?? -1) >= 0);
    assert.ok((report.summary.steadyRssBytes?.p95 ?? 0) > 0);
    assert.ok((report.summary.moduleLoads?.p95 ?? 0) >= 2);
    assert.strictEqual(report.summary.filesystemWalks?.p95, 1);
    assert.strictEqual(report.summary.watcherRegistrations?.p95, 1);
    assert.strictEqual(report.hardConditions.passed, true);
    assert.deepStrictEqual(report.hardConditions.counts, {
      rsglModuleLoads: 0,
      rsglProcessSpawnAttempts: 0,
      rsglWorkerSpawnAttempts: 0,
      extensionOwnedNonRsglProcessSpawns: 0,
      hostProcessSpawnNoise: 0,
      rsglFilesystemWalks: 0,
      mainWatcherRegistrations: 0,
      samplesMissingMainWatcherPositiveControl: 0,
      rsglWatcherRegistrations: 0,
      instrumentationWarnings: 0
    });
    assert.strictEqual(report.valid, true);
    assert.strictEqual(report.samples.length, 3);
    assert.strictEqual(new Set(report.samples.map(sample => sample.sampleId)).size, 3);
    for (const sample of report.samples) {
      assert.strictEqual(sample.status, "ok");
      assert.strictEqual(sample.probeRunId, report.probeRunId);
      assert.match(sample.sampleId, /^[a-f0-9]{32}$/);
      assert.strictEqual(sample.artifact.sha256, report.input.artifactSha256);
      assert.strictEqual(sample.artifact.bytes, report.input.artifactBytes);
      assert.ok(sample.installedHooks.includes("_load"));
      assert.ok(sample.installedHooks.includes("Worker"));
      assert.strictEqual(sample.filesystemWalks[0].api, "vscode.workspace.findFiles");
      assert.strictEqual(sample.watcherRegistrations[0].target, "**/*.json");
      assert.strictEqual(sample.instrumentationWarnings.length, 0);
    }
  });

  it("records blocked process starts and RSGL module/walk violations before failing the gate", () => {
    const fixture = createFixture();
    writeFile(fixture.extensionRoot, "bundle/features/rsglHost.js", "module.exports = {};\n");
    fs.mkdirSync(path.join(fixture.extensionRoot, "rsgl-source"), { recursive: true });
    const bundle = writeFile(fixture.extensionRoot, "bundle/extension.js", [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const childProcess = require("node:child_process");',
      "exports.activate = () => {",
      '  require("./features/rsglHost.js");',
      '  fs.readdirSync(path.join(__dirname, "..", "rsgl-source"));',
      '  childProcess.spawn(process.execPath, ["bundle/rsgl/server.js"]);',
      "};"
    ].join("\n"));
    const output = path.join(fixture.root, "raw", "violations.json");
    const result = runProbe([
      "--bundle", bundle,
      "--extension-root", fixture.extensionRoot,
      "--workspace", fixture.workspaceRoot,
      "--iterations", "1",
      "--settle-ms", "0",
      "--out", output
    ]);

    assert.strictEqual(result.status, 1, result.stderr);
    const report = readJson<ProbeReport>(output);
    assert.strictEqual(report.valid, false);
    assert.strictEqual(report.summary.successfulSamples, 0);
    assert.strictEqual(report.summary.failedSamples, 1);
    assert.strictEqual(report.hardConditions.rsglModuleLoadsZero, false);
    assert.strictEqual(report.hardConditions.rsglProcessSpawnAttemptsZero, false);
    assert.strictEqual(report.hardConditions.rsglFilesystemWalksZero, false);
    assert.ok(report.hardConditions.counts.rsglModuleLoads > 0);
    assert.strictEqual(report.hardConditions.counts.rsglProcessSpawnAttempts, 1);
    assert.strictEqual(report.hardConditions.counts.rsglFilesystemWalks, 1);
    const sample = report.samples[0];
    assert.strictEqual(sample.status, "error");
    assert.strictEqual(sample.error?.code, "ACTIVATION_PROBE_BLOCKED_OPERATION");
    assert.strictEqual(sample.processSpawns[0].api, "node:child_process.spawn");
    assert.ok(sample.moduleLoads.some(event => event.rsgl && event.request.includes("rsglHost")));
    assert.ok(sample.filesystemWalks.some(event => event.rsgl && event.target.includes("rsgl-source")));
  });

  it("keeps a strict real-Extension-Host runner entry instead of falling back to the Node stub", () => {
    assert.deepStrictEqual(probe.activationProbeAdapters, ["node-bundle", "extension-host"]);
    assert.deepStrictEqual(probe.defaultActivationProbeOutputs, {
      "node-bundle": "dist/measurements/json-only-activation.node-bundle.json",
      "extension-host": "dist/measurements/json-only-activation.extension-host.json"
    });
    assert.strictEqual(probe.extensionHostRunnerProtocol.version, 3);
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--sample-out"));
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--probe-run-id"));
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--sample-id"));
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--artifact-sha256"));
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--artifact-bytes"));
    assert.ok(probe.extensionHostRunnerProtocol.requiredArguments.includes("--extension-root"));
    assert.match(probe.extensionHostRunnerProtocol.requirement, /real VS Code Extension Host/);
    assert.throws(
      () => probe.parseActivationProbeArguments(["--adapter", "extension-host"]),
      /requires --runner and --artifact.*never substitutes the Node stub/
    );
    assert.throws(
      () => probe.parseActivationProbeArguments([
        "--adapter", "node-bundle",
        "--artifact", "fake.vsix",
        "--runner", "fake-runner.mjs"
      ]),
      /accepts --bundle/
    );

    const parsed = extensionHostSample.parseExtensionHostSampleArguments([
      "--artifact", "dist/combined-production.vsix",
      "--extension-root", "dist/measurements/prepared/extension",
      "--workspace", "test/fixtures/resource-project/mixed-pack/project",
      "--iteration", "7",
      "--settle-ms", "50",
      "--sample-out", "dist/measurements/sample.json",
      "--probe-run-id", "a".repeat(32),
      "--sample-id", "b".repeat(32),
      "--artifact-sha256", "c".repeat(64),
      "--artifact-bytes", "123"
    ]);
    assert.strictEqual(parsed.probeRunId, "a".repeat(32));
    assert.strictEqual(parsed.sampleId, "b".repeat(32));
    assert.deepStrictEqual(parsed.artifactIdentity, {
      sha256: "c".repeat(64),
      bytes: 123
    });
    assert.strictEqual(parsed.iteration, 7);
    assert.strictEqual(parsed.settleMilliseconds, 50);
    assert.ok(path.isAbsolute(parsed.artifact));
    assert.ok(path.isAbsolute(parsed.extensionRoot));
    assert.ok(path.isAbsolute(parsed.workspace));
    assert.ok(path.isAbsolute(parsed.sampleOutput));
    assert.throws(
      () => extensionHostSample.parseExtensionHostSampleArguments([
        "--artifact", "combined.vsix",
        "--workspace", "workspace"
      ]),
      /Missing required Extension Host sample argument/
    );
    assert.ok(fs.existsSync(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "extension-host-run.cjs"
    )));
    const realRunner = fs.readFileSync(path.join(
      repositoryRoot,
      "scripts",
      "activation-probe",
      "extension-host-run.cjs"
    ), "utf8");
    assert.match(realRunner, /createTargetVscodeApiInstrumentation/);
    assert.match(realRunner, /targetVscodeApi\.observeModuleLoad/);
    assert.match(realRunner, /timeOrigin:\s*performance\.timeOrigin/);
    assert.match(realRunner, /sessionId:\s*vscode\.env\.sessionId/);
    assert.match(realRunner, /durationMilliseconds:\s*performance\.now\(\)\s*-\s*started/);
  });

  it("rejects stale challenges and runner exits that contradict the written sample", () => {
    const fixture = createFixture();
    writeFile(fixture.extensionRoot, "package.json", '{"name":"fake-extension"}');
    writeFile(fixture.extensionRoot, "bundle/extension.js", "exports.activate = () => undefined;");
    const artifact = fixture.extensionRoot;

    const wrongExitRunner = writeFakeExtensionHostRunner(fixture.root, "wrong-exit.mjs", {
      echoChallenges: true,
      exitCode: 1
    });
    const wrongExitOutput = path.join(fixture.root, "raw", "wrong-exit.json");
    const wrongExit = runProbe([
      "--adapter", "extension-host",
      "--runner", wrongExitRunner,
      "--artifact", artifact,
      "--artifact-kind", "extension-directory",
      "--workspace", fixture.workspaceRoot,
      "--iterations", "1",
      "--settle-ms", "0",
      "--out", wrongExitOutput
    ]);
    assert.strictEqual(wrongExit.status, 1, wrongExit.stderr);
    assert.match(
      readJson<ProbeReport>(wrongExitOutput).samples[0].error?.message ?? "",
      /exit status 1 contradicts sample status 'ok'/
    );

    const staleRunner = writeFakeExtensionHostRunner(fixture.root, "stale.mjs", {
      echoChallenges: false,
      exitCode: 0
    });
    const staleOutput = path.join(fixture.root, "raw", "stale.json");
    const stale = runProbe([
      "--adapter", "extension-host",
      "--runner", staleRunner,
      "--artifact", artifact,
      "--artifact-kind", "extension-directory",
      "--workspace", fixture.workspaceRoot,
      "--iterations", "1",
      "--settle-ms", "0",
      "--out", staleOutput
    ]);
    assert.strictEqual(stale.status, 1, stale.stderr);
    assert.match(
      readJson<ProbeReport>(staleOutput).samples[0].error?.message ?? "",
      /did not echo its iteration, challenges, and artifact identity/
    );
  });

  it("keeps the existing cold-activation leaf compatible with the shared VS Code stub", () => {
    const fixture = createFixture();
    const bundle = writeFile(fixture.extensionRoot, "bundle/extension.js", [
      'const vscode = require("vscode");',
      "exports.activate = context => {",
      '  context.subscriptions.push(vscode.workspace.createFileSystemWatcher("**/*.json"));',
      "};"
    ].join("\n"));
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "measure-cold-activation.mjs"), bundle],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }
    );

    assert.strictEqual(result.status, 0, result.stderr);
    const measurement = JSON.parse(result.stdout) as { milliseconds?: number };
    assert.ok(Number.isFinite(measurement.milliseconds));
    assert.ok((measurement.milliseconds ?? -1) >= 0);
  });

  function createFixture(): { root: string; extensionRoot: string; workspaceRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-activation-contract-"));
    temporaryRoots.push(root);
    const extensionRoot = path.join(root, "extension");
    const workspaceRoot = path.join(root, "workspace");
    writeFile(workspaceRoot, "pack.mcmeta", JSON.stringify({ pack: { pack_format: 65, description: "test" } }));
    writeFile(
      workspaceRoot,
      "assets/test/models/block/example.json",
      JSON.stringify({ parent: "minecraft:block/cube_all" })
    );
    return { root, extensionRoot, workspaceRoot };
  }

  function runProbe(args: string[]) {
    return spawnSync(process.execPath, [probeScript, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000
    });
  }
});

function writeFile(root: string, relativePath: string, contents: string): string {
  const fileName = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, contents);
  return fileName;
}

function writeFakeExtensionHostRunner(
  root: string,
  relativePath: string,
  options: { echoChallenges: boolean; exitCode: number }
): string {
  const challengeExpression = (flag: string, fallback: string) => options.echoChallenges
    ? `values.get(${JSON.stringify(flag)})`
    : JSON.stringify(fallback);
  return writeFile(root, relativePath, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const values = new Map();",
    "for (let index = 2; index < process.argv.length; index += 2) {",
    "  values.set(process.argv[index], process.argv[index + 1]);",
    "}",
    "const sample = {",
    "  schemaVersion: 3,",
    '  adapter: "extension-host",',
    `  probeRunId: ${challengeExpression("--probe-run-id", "0".repeat(32))},`,
    `  sampleId: ${challengeExpression("--sample-id", "1".repeat(32))},`,
    "  artifact: {",
    '    sha256: values.get("--artifact-sha256"),',
    '    bytes: Number(values.get("--artifact-bytes"))',
    "  },",
    '  iteration: Number(values.get("--iteration")),',
    '  status: "ok",',
    '  activatedExtensionRoot: values.get("--extension-root"),',
    "  extensionHost: {",
    "    pid: process.pid,",
    "    timeOrigin: performance.timeOrigin,",
    '    sessionId: "contract-session",',
    "    node: process.version,",
    "    platform: process.platform,",
    "    arch: process.arch,",
    '    vscodeVersion: "1.109.0"',
    "  },",
    "  activationMilliseconds: 1,",
    "  rssBeforeBytes: 1,",
    "  rssAfterActivationBytes: 1,",
    "  steadyRssBytes: 1,",
    "  rssDeltaBytes: 0,",
    "  installedHooks: [],",
    "  moduleLoads: [],",
    "  processSpawns: [],",
    "  workerSpawns: [],",
    "  filesystemWalks: [],",
    "  watcherRegistrations: [],",
    "  instrumentationWarnings: []",
    "};",
    'const output = path.resolve(values.get("--sample-out"));',
    "fs.mkdirSync(path.dirname(output), { recursive: true });",
    'fs.writeFileSync(output, `${JSON.stringify(sample)}\\n`, "utf8");',
    `process.exitCode = ${options.exitCode};`
  ].join("\n"));
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}
