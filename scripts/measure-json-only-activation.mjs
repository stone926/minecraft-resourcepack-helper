#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activationProbeAdapters,
  activationProbeReportSchemaVersion,
  activationProbeSampleSchemaVersion,
  extensionHostRunnerProtocol,
  validateActivationProbeSample
} from "./activation-probe/schema.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const nodeBundleSampleRunner = path.join(scriptDirectory, "activation-probe", "node-bundle-sample.mjs");

export const defaultActivationProbeOutputs = Object.freeze({
  "node-bundle": "dist/measurements/json-only-activation.node-bundle.json",
  "extension-host": "dist/measurements/json-only-activation.extension-host.json"
});

export { activationProbeAdapters, extensionHostRunnerProtocol };

export function parseActivationProbeArguments(args) {
  const values = new Map();
  const booleanFlags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected activation probe argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (booleanFlags.has(flag) || values.has(flag)) {
      throw new Error(`${flag} may only be specified once.`);
    }
    if (flag === "--help") {
      booleanFlags.add(flag);
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value after ${flag}.`);
    }
    values.set(flag, value);
    if (equals < 0) {
      index += 1;
    }
  }

  const knownFlags = new Set([
    "--adapter",
    "--artifact",
    "--artifact-kind",
    "--bundle",
    "--extension-root",
    "--help",
    "--iterations",
    "--out",
    "--runner",
    "--settle-ms",
    "--workspace"
  ]);
  for (const flag of [...values.keys(), ...booleanFlags]) {
    if (!knownFlags.has(flag)) {
      throw new Error(`Unknown activation probe flag: ${flag}`);
    }
  }
  if (booleanFlags.has("--help")) {
    return { help: true };
  }

  const adapter = values.get("--adapter") ?? "node-bundle";
  if (!activationProbeAdapters.includes(adapter)) {
    throw new Error(`Unknown activation probe adapter '${adapter}'. Expected ${activationProbeAdapters.join(", ")}.`);
  }
  const iterations = parseInteger(values.get("--iterations") ?? "20", "--iterations", 1, 100);
  const settleMilliseconds = parseInteger(values.get("--settle-ms") ?? "1000", "--settle-ms", 0, 10_000);
  const outputPath = path.resolve(
    repositoryRoot,
    values.get("--out") ?? defaultActivationProbeOutputs[adapter]
  );
  const workspacePath = values.has("--workspace")
    ? path.resolve(repositoryRoot, values.get("--workspace"))
    : undefined;

  if (adapter === "node-bundle") {
    if (values.has("--artifact") || values.has("--artifact-kind") || values.has("--runner")) {
      throw new Error("The node-bundle adapter accepts --bundle, not Extension Host artifact/runner options.");
    }
    const bundlePath = path.resolve(repositoryRoot, values.get("--bundle") ?? "bundle/extension.js");
    const extensionRoot = values.has("--extension-root")
      ? path.resolve(repositoryRoot, values.get("--extension-root"))
      : inferExtensionRoot(bundlePath);
    return {
      adapter,
      bundlePath,
      extensionRoot,
      iterations,
      settleMilliseconds,
      outputPath,
      workspacePath
    };
  }

  if (values.has("--bundle") || values.has("--extension-root")) {
    throw new Error("The extension-host adapter accepts --artifact and --runner, not --bundle.");
  }
  const runnerPath = values.has("--runner")
    ? path.resolve(repositoryRoot, values.get("--runner"))
    : undefined;
  const artifactPath = values.has("--artifact")
    ? path.resolve(repositoryRoot, values.get("--artifact"))
    : undefined;
  if (!runnerPath || !artifactPath) {
    throw new Error(
      "The extension-host adapter requires --runner and --artifact; the harness never substitutes the Node stub for a real Extension Host."
    );
  }
  const artifactKind = values.get("--artifact-kind") ?? "extension-directory";
  if (!new Set(["extension-directory", "vsix", "combined-vsix"]).has(artifactKind)) {
    throw new Error("--artifact-kind must be extension-directory, vsix, or combined-vsix.");
  }
  return {
    adapter,
    runnerPath,
    artifactPath,
    artifactKind,
    iterations,
    settleMilliseconds,
    outputPath,
    workspacePath
  };
}

export function runJsonOnlyActivationProbe(options) {
  validateProbeInputs(options);
  const ownedWorkspaceRoot = options.workspacePath ? undefined : createJsonOnlyWorkspace();
  const workspaceRoot = options.workspacePath ?? ownedWorkspaceRoot;
  const sampleRoot = mkdtempSync(path.join(os.tmpdir(), "mcres-activation-samples-"));
  try {
    assertJsonOnlyWorkspace(workspaceRoot);
    const samples = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      const sampleFile = path.join(sampleRoot, `sample-${iteration}.json`);
      try {
        const sample = options.adapter === "node-bundle"
          ? runNodeBundleSample(options, workspaceRoot, iteration, sampleFile)
          : runExtensionHostSample(options, workspaceRoot, iteration, sampleFile);
        samples.push(validateActivationProbeSample(sample, options.adapter));
      } catch (error) {
        samples.push(createRunnerFailureSample(options.adapter, iteration, error));
      }
    }

    const report = createActivationProbeReport(options, workspaceRoot, samples);
    mkdirSync(path.dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    rmSync(sampleRoot, { recursive: true, force: true });
    if (ownedWorkspaceRoot) {
      rmSync(ownedWorkspaceRoot, { recursive: true, force: true });
    }
  }
}

function runNodeBundleSample(options, workspaceRoot, iteration, sampleFile) {
  const result = spawnSync(process.execPath, [
    "--expose-gc",
    nodeBundleSampleRunner,
    "--bundle",
    options.bundlePath,
    "--extension-root",
    options.extensionRoot,
    "--workspace",
    workspaceRoot,
    "--iteration",
    String(iteration),
    "--settle-ms",
    String(options.settleMilliseconds),
    "--sample-out",
    sampleFile
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  return readRunnerSample(result, sampleFile, "Node bundle sample runner");
}

function runExtensionHostSample(options, workspaceRoot, iteration, sampleFile) {
  const result = spawnSync(process.execPath, [
    options.runnerPath,
    "--artifact",
    options.artifactPath,
    "--workspace",
    workspaceRoot,
    "--iteration",
    String(iteration),
    "--settle-ms",
    String(options.settleMilliseconds),
    "--sample-out",
    sampleFile
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000
  });
  return readRunnerSample(result, sampleFile, "Extension Host sample runner");
}

function readRunnerSample(result, sampleFile, label) {
  if (existsSync(sampleFile)) {
    try {
      return JSON.parse(readFileSync(sampleFile, "utf8"));
    } catch (error) {
      throw new Error(`${label} wrote invalid sample JSON.`, { cause: error });
    }
  }
  const detail = [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(-4_000);
  throw new Error(`${label} did not write ${sampleFile}.${detail ? `\n${detail}` : ""}`);
}

function createActivationProbeReport(options, workspaceRoot, samples) {
  const successful = samples.filter(sample => sample.status === "ok");
  const hardConditions = summarizeHardConditions(samples);
  const scope = createMeasurementScope(options);
  const artifactPath = options.adapter === "node-bundle" ? options.bundlePath : options.artifactPath;
  const artifactDetails = describeArtifact(artifactPath);
  return Object.freeze({
    schemaVersion: activationProbeReportSchemaVersion,
    measurement: "json-only-activation",
    generatedAt: new Date().toISOString(),
    repositoryCommit: readRepositoryCommit(),
    scope,
    command: createReproductionCommand(options),
    rawOutput: relativeOrAbsolute(options.outputPath),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(),
      extensionHost: summarizeExtensionHostEnvironment(successful)
    },
    input: {
      artifact: relativeOrAbsolute(artifactPath),
      artifactBytes: artifactDetails.bytes,
      artifactSha256: artifactDetails.sha256,
      workspace: options.workspacePath ? relativeOrAbsolute(workspaceRoot) : "generated-json-only-pack",
      iterations: options.iterations,
      settleMilliseconds: options.settleMilliseconds
    },
    summary: {
      successfulSamples: successful.length,
      failedSamples: samples.length - successful.length,
      activationMilliseconds: distribution(successful.map(sample => sample.activationMilliseconds)),
      steadyRssBytes: distribution(successful.map(sample => sample.steadyRssBytes)),
      rssDeltaBytes: distribution(successful.map(sample => sample.rssDeltaBytes)),
      moduleLoads: distribution(successful.map(sample => sample.moduleLoads.length)),
      filesystemWalks: distribution(successful.map(sample => sample.filesystemWalks.length)),
      watcherRegistrations: distribution(successful.map(sample => sample.watcherRegistrations.length))
    },
    hardConditions,
    valid: successful.length === samples.length && hardConditions.passed,
    samples
  });
}

function createMeasurementScope(options) {
  if (options.adapter === "node-bundle") {
    return {
      adapter: "node-bundle",
      executionSurface: "fresh-node-process-with-vscode-api-stub",
      artifactKind: "root-bundle",
      isExtensionHost: false,
      isCombinedVsix: false,
      claim: "Node bundle probe only; this is not an installed extension, VS Code Extension Host, or combined VSIX measurement.",
      limitations: [
        "The VS Code API and JSON-only workspace are controlled stubs.",
        "The harness-created sample process is outside instrumentation and is not counted as an extension spawn.",
        "Statically inlined bundle modules are not individually visible to Node Module._load; pair this probe with esbuild metafile reachability.",
        "Use the extension-host adapter with a real runner before freezing combined VSIX p95 or RSS budgets."
      ]
    };
  }
  return {
    adapter: "extension-host",
    executionSurface: "external-real-vscode-extension-host-runner",
    artifactKind: options.artifactKind,
    isExtensionHost: true,
    isCombinedVsix: options.artifactKind === "combined-vsix",
    claim: options.artifactKind === "combined-vsix"
      ? "Combined VSIX data supplied by an explicit real Extension Host runner."
      : "Extension Host data supplied by an explicit real runner; not claimed as combined VSIX.",
    runnerProtocol: extensionHostRunnerProtocol,
    limitations: [
      "The external runner owns VS Code installation, isolation, activation trigger, and extension-side instrumentation.",
      "This aggregator validates the common sample schema but cannot upgrade a development-directory run into combined VSIX evidence."
    ]
  };
}

function summarizeHardConditions(samples) {
  const rsglModuleLoads = sum(samples, sample => sample.moduleLoads.filter(event => event.rsgl).length);
  const rsglProcessSpawnAttempts = sum(samples, sample => sample.processSpawns.filter(event => event.rsgl).length);
  const rsglWorkerSpawnAttempts = sum(samples, sample => sample.workerSpawns.filter(event => event.rsgl).length);
  const extensionOwnedNonRsglProcessSpawns = sum(samples, sample =>
    sample.processSpawns.filter(event => event.extensionOwned && !event.rsgl).length);
  const hostProcessSpawnNoise = sum(samples, sample =>
    sample.processSpawns.filter(event => !event.extensionOwned && !event.rsgl).length);
  const rsglFilesystemWalks = sum(samples, sample => sample.filesystemWalks.filter(event => event.rsgl).length);
  const rsglWatcherRegistrations = sum(samples, sample => sample.watcherRegistrations.filter(event => event.rsgl).length);
  const instrumentationWarnings = sum(samples, sample => sample.instrumentationWarnings.length);
  const conditions = {
    rsglModuleLoadsZero: rsglModuleLoads === 0,
    rsglProcessSpawnAttemptsZero: rsglProcessSpawnAttempts === 0,
    rsglWorkerSpawnAttemptsZero: rsglWorkerSpawnAttempts === 0,
    rsglFilesystemWalksZero: rsglFilesystemWalks === 0,
    rsglWatcherRegistrationsZero: rsglWatcherRegistrations === 0,
    instrumentationWarningsZero: instrumentationWarnings === 0
  };
  return {
    ...conditions,
    counts: {
      rsglModuleLoads,
      rsglProcessSpawnAttempts,
      rsglWorkerSpawnAttempts,
      extensionOwnedNonRsglProcessSpawns,
      hostProcessSpawnNoise,
      rsglFilesystemWalks,
      rsglWatcherRegistrations,
      instrumentationWarnings
    },
    passed: Object.values(conditions).every(Boolean)
  };
}

function summarizeExtensionHostEnvironment(samples) {
  if (samples.length === 0 || !samples[0].extensionHost) {
    return null;
  }
  const environments = samples.map(sample => ({
    node: sample.extensionHost.node,
    platform: sample.extensionHost.platform,
    arch: sample.extensionHost.arch,
    vscodeVersion: sample.extensionHost.vscodeVersion
  }));
  const first = environments[0];
  return {
    ...first,
    consistent: environments.every(value => JSON.stringify(value) === JSON.stringify(first)),
    distinctProcessCount: new Set(samples.map(sample => sample.extensionHost.pid)).size
  };
}

function createRunnerFailureSample(adapter, iteration, error) {
  return {
    schemaVersion: activationProbeSampleSchemaVersion,
    adapter,
    iteration,
    status: "error",
    error: { name: "ActivationProbeRunnerError", message: errorMessage(error) },
    extensionHost: adapter === "extension-host" ? {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      vscodeVersion: "runner-failure"
    } : undefined,
    activationMilliseconds: 0,
    rssBeforeBytes: 0,
    rssAfterActivationBytes: 0,
    steadyRssBytes: 0,
    rssDeltaBytes: 0,
    installedHooks: [],
    moduleLoads: [],
    processSpawns: [],
    workerSpawns: [],
    filesystemWalks: [],
    watcherRegistrations: [],
    instrumentationWarnings: [{ hook: "runner", message: errorMessage(error) }]
  };
}

function validateProbeInputs(options) {
  if (!activationProbeAdapters.includes(options.adapter)) {
    throw new Error(`Unsupported activation probe adapter: ${options.adapter}`);
  }
  for (const [label, fileName] of options.adapter === "node-bundle"
    ? [["bundle", options.bundlePath]]
    : [["artifact", options.artifactPath], ["runner", options.runnerPath]]) {
    if (!existsSync(fileName)) {
      throw new Error(`Activation probe ${label} does not exist: ${fileName}`);
    }
  }
  if (options.workspacePath && (!existsSync(options.workspacePath) || !statSync(options.workspacePath).isDirectory())) {
    throw new Error(`Activation probe workspace must be a directory: ${options.workspacePath}`);
  }
}

function createJsonOnlyWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcres-json-only-pack-"));
  const modelDirectory = path.join(root, "assets", "probe", "models", "block");
  mkdirSync(modelDirectory, { recursive: true });
  writeFileSync(path.join(root, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 65, description: "Activation probe" } }));
  writeFileSync(path.join(modelDirectory, "probe.json"), JSON.stringify({ parent: "minecraft:block/cube_all" }));
  return root;
}

function assertJsonOnlyWorkspace(workspaceRoot) {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".rsgl")) {
        throw new Error(`JSON-only activation workspace contains RSGL source: ${entryPath}`);
      }
    }
  };
  visit(workspaceRoot);
}

function describeArtifact(artifactPath) {
  const details = statSync(artifactPath);
  if (!details.isFile()) {
    return { bytes: undefined, sha256: undefined };
  }
  const bytes = readFileSync(artifactPath);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function createReproductionCommand(options) {
  const argv = [
    "node",
    "scripts/measure-json-only-activation.mjs",
    "--adapter",
    options.adapter
  ];
  if (options.adapter === "node-bundle") {
    argv.push("--bundle", relativeOrAbsolute(options.bundlePath));
    if (path.resolve(options.extensionRoot) !== repositoryRoot) {
      argv.push("--extension-root", relativeOrAbsolute(options.extensionRoot));
    }
  } else {
    argv.push(
      "--runner", relativeOrAbsolute(options.runnerPath),
      "--artifact", relativeOrAbsolute(options.artifactPath),
      "--artifact-kind", options.artifactKind
    );
  }
  if (options.workspacePath) {
    argv.push("--workspace", relativeOrAbsolute(options.workspacePath));
  }
  argv.push(
    "--iterations", String(options.iterations),
    "--settle-ms", String(options.settleMilliseconds),
    "--out", relativeOrAbsolute(options.outputPath)
  );
  return { argv, display: argv.map(shellDisplayArgument).join(" ") };
}

function distribution(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function sum(samples, selector) {
  return samples.reduce((total, sample) => total + selector(sample), 0);
}

function inferExtensionRoot(bundlePath) {
  let directory = path.dirname(bundlePath);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory).toLowerCase() === "bundle") {
      return path.dirname(directory);
    }
    directory = path.dirname(directory);
  }
  return path.dirname(bundlePath);
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function relativeOrAbsolute(fileName) {
  const relative = path.relative(repositoryRoot, fileName);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replaceAll("\\", "/")
    : path.resolve(fileName).replaceAll("\\", "/");
}

function shellDisplayArgument(argument) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

function readRepositoryCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/measure-json-only-activation.mjs --adapter node-bundle [--bundle bundle/extension.js] [--iterations 20] [--out path]",
    "  node scripts/measure-json-only-activation.mjs --adapter extension-host --runner path --artifact path [--artifact-kind extension-directory|vsix|combined-vsix]",
    "",
    `Default Node raw JSON: ${defaultActivationProbeOutputs["node-bundle"]}`,
    "The node-bundle adapter never claims Extension Host or combined VSIX measurements."
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
    const options = parseActivationProbeArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const report = runJsonOnlyActivationProbe(options);
      console.log(`JSON-only activation raw report: ${path.resolve(options.outputPath)}`);
      console.log(`Measurement scope: ${report.scope.claim}`);
      console.log(`Activation p95 milliseconds: ${formatMetric(report.summary.activationMilliseconds?.p95)}`);
      console.log(`Steady RSS delta p95 bytes: ${formatMetric(report.summary.rssDeltaBytes?.p95, 0)}`);
      console.log(`Hard conditions: ${report.hardConditions.passed ? "passed" : "failed"}`);
      if (!report.valid) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

function formatMetric(value, fractionDigits = 3) {
  return Number.isFinite(value) ? value.toFixed(fractionDigits) : "unavailable";
}
