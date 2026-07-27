"use strict";

const {
  isAllowedRootActivationSourcePath,
  isRsglOwnedPath
} = require("./lib/instrumentation-core.cjs");

function recomputeExtensionHostEventFacts(sample) {
  const rsglModuleLoads = sample.moduleLoads.filter(event =>
    isRsglModuleLoadEvent(event)).length;
  const rsglProcessSpawnAttempts = sample.processSpawns.filter(event =>
    eventValues(event).some(isRsglRuntimePath)).length;
  const rsglWorkerSpawnAttempts = sample.workerSpawns.filter(event =>
    eventValues(event).some(isRsglRuntimePath)).length;
  const extensionOwnedNonRsglProcessSpawns = sample.processSpawns.filter(event =>
    isExtensionOwnedEvent(event) && !eventValues(event).some(isRsglRuntimePath)).length;
  const hostProcessSpawnNoise = sample.processSpawns.length
    - rsglProcessSpawnAttempts
    - extensionOwnedNonRsglProcessSpawns;
  const rsglFilesystemWalks = sample.filesystemWalks.filter(isRsglScanEvent).length;
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

function isRsglModuleLoadEvent(event) {
  return isRsglRuntimePath(event?.request)
    || isRsglRuntimePath(event?.resolved)
    || isRsglRuntimePath(event?.parent);
}

function isRsglScanEvent(event) {
  const target = normalizeSignal(event?.target);
  return isRsglRuntimePath(event?.caller)
    || target.endsWith(".rsgl")
    || target.includes("*.rsgl")
    || /(?:^|\/)rsgl(?:\/|$)/.test(target)
    || (event?.recursive === true && isWorkspaceTarget(target));
}

function isWorkspaceTarget(target) {
  return target === "<workspace>";
}

function isRsglSourceWatcher(value) {
  const normalized = normalizeSignal(value);
  return normalized.endsWith(".rsgl") || normalized.includes("*.rsgl");
}

function isRsglRuntimePath(value) {
  const normalized = normalizeSignal(value);
  if (isAllowedRootActivationSourcePath(normalized)) {
    return false;
  }
  // The shared structured rule plus the probe-only leak signatures: the RSGL
  // LSP client package and generic rsgl tokens keep unexpected loads visible.
  return isRsglOwnedPath(normalized)
    || normalized.includes("rsglhost")
    || normalized.includes("vscode-languageclient")
    || /(?:^|[\/._-])rsgl(?:[\/._-]|$)/.test(normalized);
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

function normalizeSignal(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

module.exports = {
  eventValues,
  isExtensionOwnedEvent,
  isRsglModuleLoadEvent,
  isRsglRuntimePath,
  isRsglScanEvent,
  isRsglSourceWatcher,
  normalizeSignal,
  recomputeExtensionHostEventFacts
};
