import { readRepositoryCommit } from "../lib/git.mjs";
import { shellDisplayArgument } from "../lib/parse.mjs";
import { pathIdentity, relativeOrAbsoluteFrom } from "../lib/paths.mjs";
import { percentile, sum } from "../lib/stats.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCanonicalExtensionHostSampleRunner } from "./extension-host-sample-process.mjs";
import {
  activationProbeReportSchemaVersion,
  extensionHostProcessInstanceKey,
  extensionHostRunnerProtocol,
  recomputeExtensionHostEventFacts
} from "./schema.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const relativeOrAbsolute = relativeOrAbsoluteFrom(repositoryRoot);

export function createActivationProbeReport(
  options,
  workspaceRoot,
  probeRunId,
  artifactDetails,
  runnerDetails,
  preparedExtension,
  samples
) {
  const successful = samples.filter(sample => sample.status === "ok");
  const hardConditions = summarizeHardConditions(samples);
  const scope = createMeasurementScope(options);
  const artifactPath = options.adapter === "node-bundle" ? options.bundlePath : options.artifactPath;
  const processIdentity = options.adapter === "extension-host"
    ? summarizeExtensionHostProcessIdentity(successful)
    : null;
  const sampleIds = new Set(samples.map(sample => sample.sampleId));
  return Object.freeze({
    schemaVersion: activationProbeReportSchemaVersion,
    measurement: "json-only-activation",
    probeRunId,
    generatedAt: new Date().toISOString(),
    repositoryCommit: readRepositoryCommit(repositoryRoot),
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
      runner: runnerDetails ? relativeOrAbsolute(options.runnerPath) : null,
      runnerBytes: runnerDetails?.bytes ?? null,
      runnerSha256: runnerDetails?.sha256 ?? null,
      preparedExtension: preparedExtension
        ? describePreparedExtensionForReport(preparedExtension)
        : null,
      workspace: options.workspacePath ? relativeOrAbsolute(workspaceRoot) : "generated-json-only-pack",
      iterations: options.iterations,
      settleMilliseconds: options.settleMilliseconds
    },
    summary: {
      successfulSamples: successful.length,
      failedSamples: samples.length - successful.length,
      distinctPidCount: processIdentity?.distinctPidCount ?? null,
      distinctProcessInstanceCount: processIdentity?.distinctProcessInstanceCount ?? null,
      distinctSessionCount: processIdentity?.distinctSessionCount ?? null,
      pidReuseCount: processIdentity?.pidReuseCount ?? null,
      activationMilliseconds: distribution(successful.map(sample => sample.activationMilliseconds)),
      steadyRssBytes: distribution(successful.map(sample => sample.steadyRssBytes)),
      rssDeltaBytes: distribution(successful.map(sample => sample.rssDeltaBytes)),
      moduleLoads: distribution(successful.map(sample => sample.moduleLoads.length)),
      filesystemWalks: distribution(successful.map(sample => sample.filesystemWalks.length)),
      watcherRegistrations: distribution(successful.map(sample => sample.watcherRegistrations.length))
    },
    hardConditions,
    valid: successful.length === samples.length
      && sampleIds.size === samples.length
      && samples.every(sample => sample.probeRunId === probeRunId)
      && (processIdentity === null
        || processIdentity.distinctProcessInstanceCount === successful.length)
      && (options.adapter !== "extension-host" || scope.canonicalRunner === true)
      && (options.adapter !== "extension-host"
        || successful.every(sample => pathIdentity(sample.activatedExtensionRoot)
          === pathIdentity(preparedExtension.extensionRoot)))
      && hardConditions.passed,
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
  const canonicalRunner = isCanonicalExtensionHostSampleRunner(options.runnerPath);
  return {
    adapter: "extension-host",
    executionSurface: canonicalRunner
      ? "canonical-real-vscode-extension-host-runner"
      : "noncanonical-extension-host-runner",
    artifactKind: options.artifactKind,
    isExtensionHost: true,
    isCombinedVsix: options.artifactKind === "combined-vsix",
    canonicalRunner,
    claim: options.artifactKind === "combined-vsix" && canonicalRunner
      ? "Combined VSIX data supplied by an explicit real Extension Host runner."
      : "Non-release Extension Host diagnostic; canonical runner and combined VSIX are both required for formal evidence.",
    runnerProtocol: extensionHostRunnerProtocol,
    limitations: [
      "The canonical runner owns VS Code installation, per-sample isolation, activation trigger, and extension-side instrumentation.",
      "Only prepared installable VSIX roots measured by the canonical runner are eligible for release comparison evidence."
    ]
  };
}

function summarizeHardConditions(samples) {
  const facts = samples.map(sample => sample.adapter === "extension-host"
    ? recomputeExtensionHostEventFacts(sample)
    : recomputeNodeBundleEventFacts(sample));
  const rsglModuleLoads = sum(facts, value => value.rsglModuleLoads);
  const rsglProcessSpawnAttempts = sum(facts, value => value.rsglProcessSpawnAttempts);
  const rsglWorkerSpawnAttempts = sum(facts, value => value.rsglWorkerSpawnAttempts);
  const extensionOwnedNonRsglProcessSpawns = sum(facts, value => value.extensionOwnedNonRsglProcessSpawns);
  const hostProcessSpawnNoise = sum(facts, value => value.hostProcessSpawnNoise);
  const rsglFilesystemWalks = sum(facts, value => value.rsglFilesystemWalks);
  const mainWatcherRegistrations = sum(facts, value => value.mainWatcherRegistrations);
  const samplesMissingMainWatcherPositiveControl = facts.filter((value, index) =>
    samples[index].adapter === "extension-host" && !value.mainWatcherPositiveControl).length;
  const rsglWatcherRegistrations = sum(facts, value => value.rsglWatcherRegistrations);
  const instrumentationWarnings = sum(facts, value => value.instrumentationWarnings);
  const conditions = {
    rsglModuleLoadsZero: rsglModuleLoads === 0,
    rsglProcessSpawnAttemptsZero: rsglProcessSpawnAttempts === 0,
    rsglWorkerSpawnAttemptsZero: rsglWorkerSpawnAttempts === 0,
    rsglFilesystemWalksZero: rsglFilesystemWalks === 0,
    mainWatcherRegistrationsPositive: samplesMissingMainWatcherPositiveControl === 0,
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
      mainWatcherRegistrations,
      samplesMissingMainWatcherPositiveControl,
      rsglWatcherRegistrations,
      instrumentationWarnings
    },
    passed: Object.values(conditions).every(Boolean)
  };
}

function recomputeNodeBundleEventFacts(sample) {
  return {
    rsglModuleLoads: sample.moduleLoads.filter(event => event.rsgl).length,
    rsglProcessSpawnAttempts: sample.processSpawns.filter(event => event.rsgl).length,
    rsglWorkerSpawnAttempts: sample.workerSpawns.filter(event => event.rsgl).length,
    extensionOwnedNonRsglProcessSpawns: 0,
    hostProcessSpawnNoise: sample.processSpawns.filter(event => !event.rsgl).length,
    rsglFilesystemWalks: sample.filesystemWalks.filter(event => event.rsgl).length,
    mainWatcherRegistrations: 0,
    mainWatcherPositiveControl: true,
    rsglWatcherRegistrations: sample.watcherRegistrations.filter(event => event.rsgl).length,
    instrumentationWarnings: sample.instrumentationWarnings.length
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
    consistent: environments.every(value => JSON.stringify(value) === JSON.stringify(first))
  };
}

function summarizeExtensionHostProcessIdentity(samples) {
  const distinctPidCount = new Set(samples.map(sample => sample.extensionHost.pid)).size;
  const distinctProcessInstanceCount = new Set(
    samples.map(sample => extensionHostProcessInstanceKey(sample.extensionHost))
  ).size;
  return {
    distinctPidCount,
    distinctProcessInstanceCount,
    distinctSessionCount: new Set(samples.map(sample => sample.extensionHost.sessionId)).size,
    pidReuseCount: distinctProcessInstanceCount - distinctPidCount
  };
}

function describePreparedExtensionForReport(prepared) {
  return Object.freeze({
    status: prepared.status,
    artifact: prepared.artifact,
    cacheEntryRoot: prepared.cacheEntryRoot ? relativeOrAbsolute(prepared.cacheEntryRoot) : null,
    extensionRoot: relativeOrAbsolute(prepared.extensionRoot),
    markerPath: prepared.markerPath ? relativeOrAbsolute(prepared.markerPath) : null,
    extensionTree: prepared.extensionTree,
    extractedTree: prepared.extractedTree
  });
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
  const total = sorted.reduce((accumulated, value) => accumulated + value, 0);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length
  };
}
