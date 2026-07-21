export const activationProbeReportSchemaVersion = 2;
export const activationProbeSampleSchemaVersion = 2;
export const activationProbeAdapters = Object.freeze(["node-bundle", "extension-host"]);

const activationProbeIdentifierPattern = /^[a-f0-9]{32}$/;

export const extensionHostRunnerProtocol = Object.freeze({
  version: 2,
  requiredArguments: Object.freeze([
    "--artifact",
    "--workspace",
    "--iteration",
    "--settle-ms",
    "--sample-out",
    "--probe-run-id",
    "--sample-id",
    "--artifact-sha256",
    "--artifact-bytes"
  ]),
  requirement: "Runner must launch a real VS Code Extension Host, echo the per-run and per-sample challenges, and write one activation probe sample JSON file with an exit code matching its status."
});

export function isActivationProbeIdentifier(value) {
  return typeof value === "string" && activationProbeIdentifierPattern.test(value);
}

export function extensionHostProcessInstanceKey(host) {
  return JSON.stringify([host.pid, host.timeOrigin]);
}

export function recomputeExtensionHostEventFacts(sample) {
  const rsglModuleLoads = sample.moduleLoads.filter(event =>
    isRsglRuntimePath(event.request)
    || isRsglRuntimePath(event.resolved)
    || isRsglRuntimePath(event.parent)).length;
  const rsglProcessSpawnAttempts = sample.processSpawns.filter(event =>
    eventValues(event).some(isRsglRuntimePath)).length;
  const rsglWorkerSpawnAttempts = sample.workerSpawns.filter(event =>
    eventValues(event).some(isRsglRuntimePath)).length;
  const extensionOwnedNonRsglProcessSpawns = sample.processSpawns.filter(event =>
    isExtensionOwnedEvent(event) && !eventValues(event).some(isRsglRuntimePath)).length;
  const hostProcessSpawnNoise = sample.processSpawns.length
    - rsglProcessSpawnAttempts
    - extensionOwnedNonRsglProcessSpawns;
  const rsglFilesystemWalks = sample.filesystemWalks.filter(event =>
    isRsglScanTarget(event.target)).length;
  const rsglWatcherRegistrations = sample.watcherRegistrations.filter(event =>
    isRsglSourceWatcher(event.target)).length;
  const mainWatcherRegistrations = sample.watcherRegistrations.length
    - rsglWatcherRegistrations;
  const mainWatcherPositiveControl = sample.watcherRegistrations.some(event =>
    event.api === "vscode.workspace.createFileSystemWatcher"
    && normalizeSignal(event.target).includes("pack.mcmeta")
    && !isRsglSourceWatcher(event.target));
  return Object.freeze({
    rsglModuleLoads,
    rsglProcessSpawnAttempts,
    rsglWorkerSpawnAttempts,
    extensionOwnedNonRsglProcessSpawns,
    hostProcessSpawnNoise,
    rsglFilesystemWalks,
    mainWatcherRegistrations,
    mainWatcherPositiveControl,
    rsglWatcherRegistrations,
    instrumentationWarnings: sample.instrumentationWarnings.length
  });
}

export function validateActivationProbeSample(sample, expectedAdapter) {
  if (!sample || typeof sample !== "object") {
    throw new Error("Activation probe runner did not emit a JSON object sample.");
  }
  if (sample.schemaVersion !== activationProbeSampleSchemaVersion) {
    throw new Error(`Unsupported activation probe sample schema: ${sample.schemaVersion}`);
  }
  if (sample.adapter !== expectedAdapter) {
    throw new Error(`Activation probe sample adapter '${sample.adapter}' does not match '${expectedAdapter}'.`);
  }
  if (sample.status !== "ok" && sample.status !== "error") {
    throw new Error(`Activation probe sample has invalid status: ${sample.status}`);
  }
  if (!Number.isSafeInteger(sample.iteration) || sample.iteration < 0) {
    throw new Error("Activation probe sample iteration must be a non-negative integer.");
  }
  if (!isActivationProbeIdentifier(sample.probeRunId)
    || !isActivationProbeIdentifier(sample.sampleId)) {
    throw new Error("Activation probe samples must echo valid probeRunId and sampleId challenges.");
  }
  if (!sample.artifact
    || !Number.isSafeInteger(sample.artifact.bytes) || sample.artifact.bytes <= 0
    || typeof sample.artifact.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(sample.artifact.sha256)) {
    throw new Error("Activation probe samples must identify the measured artifact bytes and SHA-256.");
  }
  if (expectedAdapter === "extension-host") {
    const host = sample.extensionHost;
    if (!host || typeof host !== "object"
      || !Number.isSafeInteger(host.pid) || host.pid <= 0
      || !Number.isFinite(host.timeOrigin) || host.timeOrigin <= 0
      || typeof host.sessionId !== "string" || host.sessionId.length === 0
      || typeof host.node !== "string" || !/^v\d+/.test(host.node)
      || typeof host.platform !== "string" || host.platform.length === 0
      || typeof host.arch !== "string" || host.arch.length === 0
      || typeof host.vscodeVersion !== "string" || host.vscodeVersion.length === 0) {
      throw new Error("Extension Host samples must identify the fresh VS Code host process and runtime.");
    }
  }
  for (const metric of [
    "activationMilliseconds",
    "rssBeforeBytes",
    "rssAfterActivationBytes",
    "steadyRssBytes",
    "rssDeltaBytes"
  ]) {
    if (!Number.isFinite(sample[metric])) {
      throw new Error(`Activation probe sample metric '${metric}' must be finite.`);
    }
  }
  for (const metric of ["rssBeforeBytes", "rssAfterActivationBytes", "steadyRssBytes"]) {
    if (!Number.isSafeInteger(sample[metric]) || sample[metric] <= 0) {
      throw new Error(`Activation probe sample metric '${metric}' must be a positive safe integer.`);
    }
  }
  if (sample.rssDeltaBytes !== sample.steadyRssBytes - sample.rssBeforeBytes) {
    throw new Error("Activation probe sample rssDeltaBytes must match steadyRssBytes - rssBeforeBytes.");
  }
  for (const collection of [
    "moduleLoads",
    "processSpawns",
    "workerSpawns",
    "filesystemWalks",
    "watcherRegistrations",
    "instrumentationWarnings"
  ]) {
    if (!Array.isArray(sample[collection])) {
      throw new Error(`Activation probe sample collection '${collection}' must be an array.`);
    }
  }
  if (expectedAdapter === "extension-host"
    && sample.moduleLoads.some(event => !Number.isFinite(event?.durationMilliseconds)
      || event.durationMilliseconds < 0)) {
    throw new Error("Extension Host module load events must include a finite non-negative durationMilliseconds value.");
  }
  if (expectedAdapter === "extension-host") {
    assertReportedExtensionHostEventClassifications(sample);
  }
  return sample;
}

function assertReportedExtensionHostEventClassifications(sample) {
  for (const [collection, classify] of [
    [sample.moduleLoads, event => isRsglRuntimePath(event.request)
      || isRsglRuntimePath(event.resolved)
      || isRsglRuntimePath(event.parent)],
    [sample.processSpawns, event => eventValues(event).some(isRsglRuntimePath)],
    [sample.workerSpawns, event => eventValues(event).some(isRsglRuntimePath)],
    [sample.filesystemWalks, event => isRsglScanTarget(event.target)],
    [sample.watcherRegistrations, event => isRsglSourceWatcher(event.target)]
  ]) {
    for (const event of collection) {
      const expected = classify(event);
      if (typeof event?.rsgl !== "boolean" || event.rsgl !== expected) {
        throw new Error("Extension Host activation event has an inconsistent rsgl classification.");
      }
    }
  }
  for (const event of [...sample.processSpawns, ...sample.workerSpawns]) {
    if (typeof event?.extensionOwned !== "boolean"
      || event.extensionOwned !== isExtensionOwnedEvent(event)) {
      throw new Error("Extension Host process event has an inconsistent extensionOwned classification.");
    }
  }
  for (const event of [...sample.filesystemWalks, ...sample.watcherRegistrations]) {
    if (event?.api?.startsWith("vscode.")
      && event.extensionOwned !== true) {
      throw new Error("Target-scoped VS Code activation events must be extensionOwned.");
    }
  }
}

function isExtensionOwnedEvent(event) {
  return normalizeSignal(event?.caller).includes("<extension>");
}

function eventValues(event) {
  return [
    event?.file,
    event?.caller,
    ...(Array.isArray(event?.args) ? event.args : []),
    ...(Array.isArray(event?.arguments) ? event.arguments : [])
  ];
}

function isRsglRuntimePath(value) {
  const normalized = normalizeSignal(value);
  return normalized.includes("rsglhost")
    || normalized.includes("vscode-languageclient")
    || /(?:^|[\/._-])rsgl(?:[\/._-]|$)/.test(normalized);
}

function isRsglScanTarget(value) {
  const normalized = normalizeSignal(value);
  return normalized.endsWith(".rsgl")
    || normalized.includes("/**/*.rsgl")
    || normalized.includes("/rsgl/src")
    || normalized.includes("/rsgl/stdlib");
}

function isRsglSourceWatcher(value) {
  const normalized = normalizeSignal(value);
  return normalized.endsWith(".rsgl") || normalized.includes("*.rsgl");
}

function normalizeSignal(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}
