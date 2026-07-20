export const activationProbeReportSchemaVersion = 1;
export const activationProbeSampleSchemaVersion = 1;
export const activationProbeAdapters = Object.freeze(["node-bundle", "extension-host"]);

export const extensionHostRunnerProtocol = Object.freeze({
  version: 1,
  requiredArguments: Object.freeze([
    "--artifact",
    "--workspace",
    "--iteration",
    "--settle-ms",
    "--sample-out"
  ]),
  requirement: "Runner must launch a real VS Code Extension Host and write one activation probe sample JSON file."
});

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
  if (expectedAdapter === "extension-host") {
    const host = sample.extensionHost;
    if (!host || typeof host !== "object"
      || !Number.isSafeInteger(host.pid) || host.pid <= 0
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
  return sample;
}
