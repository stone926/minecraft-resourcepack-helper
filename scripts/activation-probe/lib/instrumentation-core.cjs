"use strict";

/**
 * Shared, dependency-free instrumentation core for the Extension Host probes:
 * the packaged smoke runner (scripts/extension-host-smoke/run.cjs) and the
 * activation probe runner (scripts/activation-probe/extension-host-run.cjs)
 * install the same child-process hooks and share one structured RSGL path
 * rule. Everything here must stay requireable inside a VS Code Extension Host
 * without npm dependencies.
 */

const { bundleEntryOutfiles } = require("../../lib/bundleEntries.cjs");

const PROCESS_START_APIS = Object.freeze([
  "spawn",
  "spawnSync",
  "fork",
  "exec",
  "execSync",
  "execFile",
  "execFileSync"
]);

/** Lowercased forward-slash sub-paths of the three lazy RSGL runtime bundles. */
const rsglRuntimeBundleSubpaths = Object.freeze(
  ["rsglHost", "server", "worker"].map(id => `/${bundleEntryOutfiles[id].toLowerCase()}`)
);

/**
 * Root activation source files that are allowed to load eagerly: they wire the
 * lazy RSGL subsystem without pulling in its implementation.
 */
const allowedRootActivationBaseNames = Object.freeze([
  "loadinstalledrsglsubsystem",
  "registerlazyrsglsubsystem",
  "rsglactivationsignals"
]);

function normalizeSignalPath(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

/** True for src/rsgl/ files that the root activation path may legally load. */
function isAllowedRootActivationSourcePath(value) {
  const match = /(?:^|\/)src\/rsgl\/([^/]+)$/.exec(normalizeSignalPath(value));
  if (!match) {
    return false;
  }
  const baseName = match[1].replace(/\.[a-z]+$/, "");
  return allowedRootActivationBaseNames.includes(baseName);
}

/**
 * The one structured RSGL ownership rule shared by every probe: exact lazy
 * bundle paths (single-sourced from scripts/lib/bundleEntries.cjs), the
 * packages/rsgl-* workspaces, and src/rsgl/ sources except the allowed root
 * activation files.
 */
function isRsglOwnedPath(value) {
  const normalized = normalizeSignalPath(value);
  if (rsglRuntimeBundleSubpaths.some(subpath => normalized.includes(subpath))) {
    return true;
  }
  if (/(?:^|\/)packages\/rsgl-/.test(normalized)) {
    return true;
  }
  return /(?:^|\/)src\/rsgl\//.test(normalized)
    && !isAllowedRootActivationSourcePath(normalized);
}

/**
 * Wraps every child_process start API and records one event per call. The
 * event always carries extensionOwned and rsgl ownership; callers decorate
 * further (for example smoke attribution) through options.decorateEvent.
 */
function instrumentProcessStarts(childProcess, events, options) {
  const {
    sanitize,
    isExtensionOwnedCaller,
    isRsglRuntimePath,
    callsiteLabel,
    decorateEvent,
    onHookInstalled
  } = options;
  const originals = new Map();
  for (const api of PROCESS_START_APIS) {
    const original = childProcess[api];
    originals.set(api, original);
    childProcess[api] = function instrumentedProcessStart(...args) {
      const eventArguments = sanitizeArguments(args, sanitize);
      const caller = captureCaller(callsiteLabel);
      const event = {
        api,
        arguments: eventArguments,
        caller: sanitize(caller),
        extensionOwned: isExtensionOwnedCaller(caller),
        rsgl: eventArguments.some(isRsglRuntimePath) || isRsglRuntimePath(caller)
      };
      if (decorateEvent) {
        decorateEvent(event);
      }
      events.push(event);
      const child = original.apply(this, args);
      event.pid = child?.pid;
      return child;
    };
    if (onHookInstalled) {
      onHookInstalled(`child_process.${api}`);
    }
  }
  return () => {
    for (const [api, original] of originals) {
      childProcess[api] = original;
    }
  };
}

function sanitizeArguments(args, sanitize) {
  return args.flatMap(value => {
    if (typeof value === "string") {
      return [sanitize(value)];
    }
    if (Array.isArray(value)) {
      return value.filter(item => typeof item === "string").map(sanitize);
    }
    if (value instanceof URL) {
      return [sanitize(value.href)];
    }
    return [];
  });
}

function captureCaller(callsiteLabel) {
  return new Error(callsiteLabel).stack ?? "";
}

/** Case-tolerant containment of the extension root inside a caller stack. */
function createExtensionOwnedCallerPredicate(extensionRoot) {
  const normalize = candidate => process.platform === "win32"
    ? candidate.replaceAll("\\", "/").toLowerCase()
    : candidate.replaceAll("\\", "/");
  const normalizedRoot = normalize(extensionRoot);
  return value => normalize(value).includes(normalizedRoot);
}

/** True once the lazy RSGL host bundle is present in the require cache. */
function rsglHostLoaded() {
  const subpath = `/${bundleEntryOutfiles.rsglHost.toLowerCase()}`;
  return Object.keys(require.cache).some(fileName =>
    normalizeSignalPath(fileName).endsWith(subpath));
}

function settle(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

module.exports = {
  PROCESS_START_APIS,
  assert,
  captureCaller,
  createExtensionOwnedCallerPredicate,
  instrumentProcessStarts,
  isAllowedRootActivationSourcePath,
  isRsglOwnedPath,
  normalizeSignalPath,
  requiredEnvironment,
  rsglHostLoaded,
  sanitizeArguments,
  serializeError,
  settle
};
