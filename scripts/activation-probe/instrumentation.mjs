import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../lib/parse.mjs";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const fileSystem = require("node:fs");
const workerThreads = require("node:worker_threads");
const {
  isAllowedRootActivationSourcePath,
  isRsglOwnedPath
} = require("./lib/instrumentation-core.cjs");
const {
  createDeferredModuleLoadRecorder,
  snapshotModuleParent
} = require("./deferred-module-loads.cjs");

export class ActivationProbeBlockedOperationError extends Error {
  constructor(operation) {
    super(`Activation probe blocked side-effecting operation: ${operation}`);
    this.name = "ActivationProbeBlockedOperationError";
    this.code = "ACTIVATION_PROBE_BLOCKED_OPERATION";
  }
}

export function createActivationTelemetry(options = {}) {
  const extensionRoot = options.extensionRoot ? path.resolve(options.extensionRoot) : undefined;
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const processSpawns = [];
  const workerSpawns = [];
  const filesystemWalks = [];
  const watcherRegistrations = [];
  const instrumentationWarnings = [];

  const sanitize = value => sanitizeValue(value, { extensionRoot, workspaceRoot });
  const deferredModuleLoads = createDeferredModuleLoadRecorder({
    resolveFilename: Module._resolveFilename,
    createEvent(rawEvent, resolved) {
      const signal = `${String(rawEvent.request)}\n${String(resolved ?? "")}`;
      return Object.freeze({
        request: sanitize(rawEvent.request),
        resolved: resolved === undefined ? undefined : sanitize(resolved),
        rsgl: isRsglSignal(signal)
      });
    }
  });
  return {
    recordModuleLoad(request, parent, isMain) {
      deferredModuleLoads.record(request, parent, isMain);
    },
    recordProcessSpawn(api, file, args) {
      const signal = `${String(file)}\n${Array.isArray(args) ? args.join("\n") : ""}`;
      processSpawns.push(Object.freeze({
        api,
        file: sanitize(file),
        args: Array.isArray(args) ? args.slice(0, 12).map(sanitize) : [],
        rsgl: isRsglSignal(signal)
      }));
    },
    recordWorkerSpawn(file, options) {
      const signal = `${String(file)}\n${String(options?.workerData ?? "")}`;
      workerSpawns.push(Object.freeze({
        api: "node:worker_threads.Worker",
        file: sanitize(file),
        rsgl: isRsglSignal(signal)
      }));
    },
    recordFilesystemWalk(api, target, details = {}) {
      const rawTarget = describeTarget(target);
      const recursive = details?.recursive === true;
      filesystemWalks.push(Object.freeze({
        api,
        target: sanitize(rawTarget),
        recursive,
        workspaceRecursive: recursive && isPathAtOrBelow(workspaceRoot, rawTarget),
        rsgl: isRsglSignal(rawTarget)
      }));
    },
    recordWatcher(api, target) {
      const rawTarget = describeTarget(target);
      watcherRegistrations.push(Object.freeze({
        api,
        target: sanitize(rawTarget),
        rsgl: isRsglSignal(rawTarget)
      }));
    },
    recordInstrumentationWarning(hook, error) {
      instrumentationWarnings.push(Object.freeze({ hook, message: errorMessage(error) }));
    },
    snapshot() {
      return Object.freeze({
        moduleLoads: deferredModuleLoads.finalize(),
        processSpawns: Object.freeze([...processSpawns]),
        workerSpawns: Object.freeze([...workerSpawns]),
        filesystemWalks: Object.freeze([...filesystemWalks]),
        watcherRegistrations: Object.freeze([...watcherRegistrations]),
        instrumentationWarnings: Object.freeze([...instrumentationWarnings])
      });
    }
  };
}

export function installNodeActivationInstrumentation(options) {
  const telemetry = options.telemetry;
  const vscode = options.vscode;
  const restorers = [];
  const installedHooks = [];

  patchMethod(Module, "_load", originalLoad => function instrumentedModuleLoad(request, parent, isMain) {
    const parentSnapshot = snapshotModuleParent(parent);
    let moduleReference;
    try {
      moduleReference = request === "vscode"
        ? vscode
        : originalLoad.call(this, request, parent, isMain);
      return moduleReference;
    } finally {
      telemetry.recordModuleLoad(request, parentSnapshot, isMain);
    }
  });

  for (const api of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    patchMethod(childProcess, api, _original => function blockedChildProcess(...args) {
      telemetry.recordProcessSpawn(`node:child_process.${api}`, args[0], processArguments(api, args));
      throw new ActivationProbeBlockedOperationError(`node:child_process.${api}`);
    });
  }

  patchMethod(workerThreads, "Worker", OriginalWorker => new Proxy(OriginalWorker, {
    construct(_target, args) {
      telemetry.recordWorkerSpawn(args[0], args[1]);
      throw new ActivationProbeBlockedOperationError("node:worker_threads.Worker");
    }
  }));

  for (const api of ["readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync"]) {
    patchMethod(fileSystem, api, original => function instrumentedFileSystemWalk(...args) {
      telemetry.recordFilesystemWalk(`node:fs.${api}`, args[0], walkDetails(api, args));
      return original.apply(this, args);
    }, api.startsWith("glob") === false);
  }
  for (const api of ["readdir", "opendir", "glob"]) {
    patchMethod(fileSystem.promises, api, original => async function instrumentedPromiseWalk(...args) {
      telemetry.recordFilesystemWalk(`node:fs.promises.${api}`, args[0], walkDetails(api, args));
      return await original.apply(this, args);
    }, api !== "glob");
  }

  patchMethod(fileSystem, "watch", _original => function instrumentedWatch(target) {
    telemetry.recordWatcher("node:fs.watch", target);
    return createWatcherStub();
  });
  patchMethod(fileSystem, "watchFile", _original => function instrumentedWatchFile(target) {
    telemetry.recordWatcher("node:fs.watchFile", target);
  });

  return Object.freeze({
    installedHooks: Object.freeze(installedHooks),
    stop() {
      for (const restore of restorers.reverse()) {
        restore();
      }
    }
  });

  function patchMethod(target, property, wrap, required = true) {
    const original = target?.[property];
    if (typeof original !== "function") {
      if (required) {
        telemetry.recordInstrumentationWarning(property, new Error("Hook target is unavailable."));
      }
      return;
    }
    try {
      target[property] = wrap(original);
      if (target[property] === original) {
        throw new Error("Hook target rejected its replacement.");
      }
      installedHooks.push(property);
      restorers.push(() => {
        target[property] = original;
      });
    } catch (error) {
      telemetry.recordInstrumentationWarning(property, error);
      if (required) {
        throw new Error(`Unable to install required activation probe hook: ${property}`, { cause: error });
      }
    }
  }
}

export function isRsglSignal(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").toLowerCase();
  if (isAllowedRootActivationSourcePath(normalized)) {
    return false;
  }
  // The shared structured rule plus the node-bundle adapter's leak signatures:
  // .rsgl source targets, the RSGL LSP client package, and generic rsgl tokens.
  return isRsglOwnedPath(normalized)
    || normalized.includes(".rsgl")
    || normalized.includes("rsglhost")
    || normalized.includes("vscode-languageclient")
    || /(?:^|[\/._-])rsgl(?:[\/._-]|$)/.test(normalized);
}

function walkDetails(api, args) {
  const options = args[1];
  return {
    recursive: typeof options === "object" && options !== null && options.recursive === true,
    pattern: api.startsWith("glob") ? describeTarget(args[0]) : undefined
  };
}

function processArguments(api, args) {
  if (api.startsWith("exec")) {
    return [];
  }
  return Array.isArray(args[1]) ? args[1] : [];
}

function createWatcherStub() {
  const watcher = {
    close() {},
    ref() { return watcher; },
    unref() { return watcher; },
    on() { return watcher; },
    once() { return watcher; },
    addListener() { return watcher; },
    removeListener() { return watcher; }
  };
  return watcher;
}

function describeTarget(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL && value.protocol === "file:") {
    return fileURLToPath(value);
  }
  if (typeof value.pattern === "string") {
    return value.pattern;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return String(value);
}

function sanitizeValue(value, roots) {
  const raw = describeTarget(value);
  if (raw.length === 0) {
    return raw;
  }
  if (!path.isAbsolute(raw)) {
    return raw.replaceAll("\\", "/");
  }
  for (const [label, root] of [["<workspace>", roots.workspaceRoot], ["<extension>", roots.extensionRoot]]) {
    if (!root || !isPathAtOrBelow(root, raw)) {
      continue;
    }
    const relative = path.relative(root, raw).replaceAll("\\", "/");
    return relative ? `${label}/${relative}` : label;
  }
  return `<absolute>/${path.basename(raw)}`;
}

function isPathAtOrBelow(parent, target) {
  if (!parent || typeof target !== "string" || !path.isAbsolute(target)) {
    return false;
  }
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
