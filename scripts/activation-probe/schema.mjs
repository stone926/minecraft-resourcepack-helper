import eventClassification from "./event-classification.cjs";

const {
  eventValues,
  isExtensionOwnedEvent,
  isRsglModuleLoadEvent,
  isRsglRuntimePath,
  isRsglScanEvent,
  isRsglSourceWatcher,
  recomputeExtensionHostEventFacts
} = eventClassification;

export const activationProbeReportSchemaVersion = 3;
export const activationProbeSampleSchemaVersion = 3;
export const activationProbeAdapters = Object.freeze(["node-bundle", "extension-host"]);
export const activationEvidenceTrustBoundary = "Reproducible local measurement with canonical-code, artifact, process, schedule, and tree consistency checks; it detects stale or internally inconsistent evidence but is not a cryptographic attestation against deliberately fabricated telemetry.";

const activationProbeIdentifierPattern = /^[a-f0-9]{32}$/;

export const extensionHostRunnerProtocol = Object.freeze({
  version: 3,
  requiredArguments: Object.freeze([
    "--artifact",
    "--extension-root",
    "--workspace",
    "--iteration",
    "--settle-ms",
    "--sample-out",
    "--probe-run-id",
    "--sample-id",
    "--artifact-sha256",
    "--artifact-bytes"
  ]),
  requirement: "Runner must launch a real VS Code Extension Host from the supplied prepared extension root, echo the per-run and per-sample challenges, and write one activation probe sample JSON file with an exit code matching its status."
});

export function isActivationProbeIdentifier(value) {
  return typeof value === "string" && activationProbeIdentifierPattern.test(value);
}

export function extensionHostProcessInstanceKey(host) {
  return JSON.stringify([host.pid, host.timeOrigin]);
}

export { recomputeExtensionHostEventFacts };

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
    if (sample.status === "ok"
      && (typeof sample.activatedExtensionRoot !== "string"
        || sample.activatedExtensionRoot.length === 0)) {
      throw new Error("Successful Extension Host samples must identify the activated extension root.");
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
    [sample.moduleLoads, isRsglModuleLoadEvent],
    [sample.processSpawns, event => eventValues(event).some(isRsglRuntimePath)],
    [sample.workerSpawns, event => eventValues(event).some(isRsglRuntimePath)],
    [sample.filesystemWalks, isRsglScanEvent],
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
