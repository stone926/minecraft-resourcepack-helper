#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { parseFlagValues } from "./lib/cli-args.mjs";
import { errorMessage, parseInteger } from "./lib/parse.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activationProbeAdapters,
  activationProbeSampleSchemaVersion,
  extensionHostRunnerProtocol,
  validateActivationProbeSample
} from "./activation-probe/schema.mjs";
import {
  hashPreparedExtensionTree,
  prepareVsixExtension
} from "./activation-probe/prepared-vsix.mjs";
import {
  runExtensionHostSampleProcess
} from "./activation-probe/extension-host-sample-process.mjs";
import { measurementPaths } from "./measurement-paths.mjs";
import { createChallenge } from "./activation-probe/challenge.mjs";
import { describeArtifact } from "./activation-probe/artifact-identity.mjs";
import { createActivationProbeReport } from "./activation-probe/report.mjs";
import {
  assertJsonOnlyWorkspace,
  createJsonOnlyWorkspace
} from "./activation-probe/workspace-fixture.mjs";

export { createChallenge } from "./activation-probe/challenge.mjs";
export { describeArtifact } from "./activation-probe/artifact-identity.mjs";
export { createActivationProbeReport } from "./activation-probe/report.mjs";
export {
  assertJsonOnlyWorkspace,
  createJsonOnlyWorkspace
} from "./activation-probe/workspace-fixture.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const nodeBundleSampleRunner = path.join(scriptDirectory, "activation-probe", "node-bundle-sample.mjs");

export const defaultActivationProbeOutputs = Object.freeze({
  "node-bundle": measurementPaths.activationProbe.nodeBundle,
  "extension-host": measurementPaths.activationProbe.extensionHost
});

export { activationProbeAdapters, extensionHostRunnerProtocol };

export function parseActivationProbeArguments(args) {
  const { values, booleanFlags } = parseFlagValues(args, {
    unexpectedArgument: argument => `Unexpected activation probe argument: ${argument}`,
    switchFlags: ["--help"]
  });

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

export async function runJsonOnlyActivationProbe(options) {
  validateProbeInputs(options);
  const artifactPath = options.adapter === "node-bundle" ? options.bundlePath : options.artifactPath;
  const artifactDetails = describeArtifact(artifactPath);
  const runnerDetails = options.adapter === "extension-host"
    ? describeArtifact(options.runnerPath)
    : null;
  const preparedExtension = options.adapter === "extension-host"
    ? await prepareActivationExtension(options, artifactDetails)
    : null;
  const ownedWorkspaceRoot = options.workspacePath ? undefined : createJsonOnlyWorkspace();
  const workspaceRoot = options.workspacePath ?? ownedWorkspaceRoot;
  const sampleRoot = mkdtempSync(path.join(os.tmpdir(), "mcres-activation-samples-"));
  const probeRunId = createChallenge();
  try {
    assertJsonOnlyWorkspace(workspaceRoot);
    const samples = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      const sampleFile = path.join(sampleRoot, `sample-${iteration}.json`);
      const sampleId = createChallenge();
      try {
        const sample = options.adapter === "node-bundle"
          ? runNodeBundleSample(options, workspaceRoot, iteration, sampleFile, probeRunId, sampleId, artifactDetails)
          : runExtensionHostSample(
            options,
            workspaceRoot,
            iteration,
            sampleFile,
            probeRunId,
            sampleId,
            artifactDetails,
            preparedExtension
          );
        samples.push(validateActivationProbeSample(sample, options.adapter));
      } catch (error) {
        samples.push(createRunnerFailureSample(
          options.adapter,
          iteration,
          probeRunId,
          sampleId,
          artifactDetails,
          error
        ));
      }
    }

    const finalArtifactDetails = describeArtifact(artifactPath);
    if (JSON.stringify(finalArtifactDetails) !== JSON.stringify(artifactDetails)) {
      throw new Error("Activation probe artifact changed while samples were running.");
    }
    if (runnerDetails) {
      const finalRunnerDetails = describeArtifact(options.runnerPath);
      if (JSON.stringify(finalRunnerDetails) !== JSON.stringify(runnerDetails)) {
        throw new Error("Activation probe runner changed while samples were running.");
      }
    }
    if (preparedExtension?.extensionTree) {
      const finalPreparedTree = await hashPreparedExtensionTree(preparedExtension.extensionRoot);
      if (JSON.stringify(finalPreparedTree) !== JSON.stringify(preparedExtension.extensionTree)) {
        throw new Error("Prepared activation extension changed while samples were running.");
      }
    }
    const report = createActivationProbeReport(
      options,
      workspaceRoot,
      probeRunId,
      artifactDetails,
      runnerDetails,
      preparedExtension,
      samples
    );
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

function runNodeBundleSample(options, workspaceRoot, iteration, sampleFile, probeRunId, sampleId, artifact) {
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
    sampleFile,
    "--probe-run-id",
    probeRunId,
    "--sample-id",
    sampleId,
    "--artifact-sha256",
    artifact.sha256,
    "--artifact-bytes",
    String(artifact.bytes)
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  return readRunnerSample(result, sampleFile, "Node bundle sample runner", {
    adapter: "node-bundle",
    iteration,
    probeRunId,
    sampleId,
    artifact
  });
}

function runExtensionHostSample(
  options,
  workspaceRoot,
  iteration,
  sampleFile,
  probeRunId,
  sampleId,
  artifact,
  preparedExtension
) {
  return runExtensionHostSampleProcess({
    runnerPath: options.runnerPath,
    artifactPath: options.artifactPath,
    extensionRoot: preparedExtension.extensionRoot,
    workspaceRoot,
    iteration,
    settleMilliseconds: options.settleMilliseconds,
    sampleOutput: sampleFile,
    probeRunId,
    sampleId,
    artifact,
    cwd: repositoryRoot,
    timeoutMilliseconds: 180_000
  });
}

function readRunnerSample(result, sampleFile, label, expected) {
  const detail = [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .slice(-4_000);
  if (existsSync(sampleFile)) {
    try {
      const sample = validateActivationProbeSample(
        JSON.parse(readFileSync(sampleFile, "utf8")),
        expected.adapter
      );
      if (sample.iteration !== expected.iteration
        || sample.probeRunId !== expected.probeRunId
        || sample.sampleId !== expected.sampleId
        || sample.artifact.bytes !== expected.artifact.bytes
        || sample.artifact.sha256 !== expected.artifact.sha256) {
        throw new Error(`${label} sample did not echo its iteration, challenges, and artifact identity.`);
      }
      if (result.error) {
        throw new Error(`${label} failed before its exit status could be trusted.`, {
          cause: result.error
        });
      }
      const exitMatches = sample.status === "ok"
        ? result.status === 0
        : Number.isSafeInteger(result.status) && result.status !== 0;
      if (!exitMatches) {
        throw new Error(
          `${label} exit status ${String(result.status)} is inconsistent with sample status '${sample.status}'.`
        );
      }
      return sample;
    } catch (error) {
      throw new Error(`${label} wrote an invalid or inconsistent sample: ${errorMessage(error)}.${detail ? `\n${detail}` : ""}`, {
        cause: error
      });
    }
  }
  throw new Error(`${label} did not write ${sampleFile}.${detail ? `\n${detail}` : ""}`);
}

function createRunnerFailureSample(adapter, iteration, probeRunId, sampleId, artifact, error) {
  return {
    schemaVersion: activationProbeSampleSchemaVersion,
    adapter,
    probeRunId,
    sampleId,
    artifact,
    iteration,
    status: "error",
    error: { name: "ActivationProbeRunnerError", message: errorMessage(error) },
    extensionHost: adapter === "extension-host" ? {
      pid: process.pid,
      timeOrigin: performance.timeOrigin,
      sessionId: `runner-failure-${process.pid}`,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      vscodeVersion: "runner-failure"
    } : undefined,
    activationMilliseconds: 0,
    rssBeforeBytes: 1,
    rssAfterActivationBytes: 1,
    steadyRssBytes: 1,
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

async function prepareActivationExtension(options, artifactDetails) {
  const artifactStat = statSync(options.artifactPath);
  if (artifactStat.isDirectory()) {
    if (options.artifactKind !== "extension-directory") {
      throw new Error("VSIX activation evidence requires a VSIX file, not an extension directory.");
    }
    return Object.freeze({
      status: "development-directory",
      artifact: artifactDetails,
      extensionRoot: path.resolve(options.artifactPath),
      cacheEntryRoot: null,
      markerPath: null,
      extensionTree: null,
      extractedTree: null
    });
  }
  if (!artifactStat.isFile()) {
    throw new Error(`Activation artifact must be a VSIX file or extension directory: ${options.artifactPath}`);
  }
  const prepared = await prepareVsixExtension({
    artifactPath: options.artifactPath,
    repositoryRoot
  });
  if (prepared.artifact.sha256 !== artifactDetails.sha256
    || prepared.artifact.bytes !== artifactDetails.bytes) {
    throw new Error("Prepared extension identity does not match the measured activation artifact.");
  }
  return prepared;
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


if (isMainModule(import.meta.url)) {
  try {
    const options = parseActivationProbeArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const report = await runJsonOnlyActivationProbe(options);
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
