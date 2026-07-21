const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const workerThreads = require("node:worker_threads");
const vscode = require("vscode");
const {
  createTargetVscodeApiInstrumentation
} = require("./target-vscode-api.cjs");
const {
  isRsglModuleLoadEvent,
  isRsglRuntimePath,
  isRsglScanEvent,
  isRsglSourceWatcher
} = require("./event-classification.cjs");
const { redactActivationPaths } = require("./path-redaction.cjs");

const extensionId = "stone926.minecraft-resourcepack-helper";
const iteration = Number(requiredEnvironment("MCRES_ACTIVATION_ITERATION"));
const probeRunId = requiredEnvironment("MCRES_ACTIVATION_PROBE_RUN_ID");
const sampleId = requiredEnvironment("MCRES_ACTIVATION_SAMPLE_ID");
const artifact = Object.freeze({
  sha256: requiredEnvironment("MCRES_ACTIVATION_ARTIFACT_SHA256"),
  bytes: Number(requiredEnvironment("MCRES_ACTIVATION_ARTIFACT_BYTES"))
});
const sampleOutput = requiredEnvironment("MCRES_ACTIVATION_SAMPLE_OUT");
const settleMilliseconds = Number(requiredEnvironment("MCRES_ACTIVATION_SETTLE_MS"));
const sourceWorkspace = requiredEnvironment("MCRES_ACTIVATION_SOURCE_WORKSPACE");
const workspaceRoot = requiredEnvironment("MCRES_ACTIVATION_WORKSPACE");
const extensionRoot = requiredEnvironment("MCRES_ACTIVATION_EXTENSION_ROOT");

async function run() {
  const events = createEventCollections();
  const installedHooks = [];
  const restorers = [];
  let rssBeforeBytes = process.memoryUsage().rss;
  let rssAfterActivationBytes = rssBeforeBytes;
  let steadyRssBytes = rssBeforeBytes;
  let activationMilliseconds = 0;
  let activatedExtensionRoot;
  let status = "error";
  let serializedError;
  const extensionHost = {
    pid: process.pid,
    timeOrigin: performance.timeOrigin,
    sessionId: vscode.env.sessionId,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    vscodeVersion: vscode.version
  };

  try {
    restorers.push(instrumentModuleLoads(events, installedHooks));
    restorers.push(instrumentProcessStarts(events.processSpawns, installedHooks));
    restorers.push(instrumentWorkers(events.workerSpawns, installedHooks, events.instrumentationWarnings));
    restorers.push(instrumentFilesystemWalks(events.filesystemWalks, installedHooks, events.instrumentationWarnings));

    const extension = vscode.extensions.getExtension(extensionId);
    assert(extension, `Combined extension '${extensionId}' is not installed.`);
    assert(!extension.isActive, "Combined extension was already active before the measured cold activation.");
    activatedExtensionRoot = canonicalPath(extension.extensionPath);
    assert(
      samePath(activatedExtensionRoot, canonicalPath(extensionRoot)),
      `Activated extension root does not match the prepared artifact: ${activatedExtensionRoot}`
    );

    const sourcePack = path.join(sourceWorkspace, "pack.mcmeta");
    assert(fs.existsSync(sourcePack), `JSON-only source workspace has no pack.mcmeta: ${sourcePack}`);
    fs.copyFileSync(sourcePack, path.join(workspaceRoot, "pack.mcmeta"));

    rssBeforeBytes = process.memoryUsage().rss;
    const started = performance.now();
    await extension.activate();
    activationMilliseconds = performance.now() - started;
    rssAfterActivationBytes = process.memoryUsage().rss;
    await settle(settleMilliseconds);
    steadyRssBytes = process.memoryUsage().rss;

    assert(!rsglHostLoaded(), "JSON-only activation loaded the isolated RSGL host bundle.");
    assert(!events.processSpawns.some(event => event.rsgl), "JSON-only activation started an RSGL child process.");
    assert(!events.workerSpawns.some(event => event.rsgl), "JSON-only activation started an RSGL worker.");
    status = "ok";
  } catch (error) {
    serializedError = serializeError(error);
  } finally {
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch (error) {
        events.instrumentationWarnings.push({ hook: "restore", message: serializeError(error).message });
      }
    }
    writeSample({
      schemaVersion: 3,
      adapter: "extension-host",
      probeRunId,
      sampleId,
      artifact,
      activatedExtensionRoot,
      iteration,
      status,
      error: serializedError,
      extensionHost,
      activationMilliseconds,
      rssBeforeBytes,
      rssAfterActivationBytes,
      steadyRssBytes,
      rssDeltaBytes: steadyRssBytes - rssBeforeBytes,
      installedHooks,
      ...events
    });
  }
  if (serializedError) {
    throw Object.assign(new Error(serializedError.message), { stack: serializedError.stack });
  }
}

function createEventCollections() {
  return {
    moduleLoads: [],
    processSpawns: [],
    workerSpawns: [],
    filesystemWalks: [],
    watcherRegistrations: [],
    instrumentationWarnings: []
  };
}

function instrumentModuleLoads(events, installedHooks) {
  const original = Module._load;
  const targetVscodeApi = createTargetVscodeApiInstrumentation({
    extensionRoot,
    onCall({ hook, args }) {
      const target = displayTarget(args[0]);
      if (hook === "vscode.workspace.createFileSystemWatcher") {
        events.watcherRegistrations.push({
          api: hook,
          target,
          extensionOwned: true,
          rsgl: isRsglSourceWatcher(target)
        });
        return;
      }
      events.filesystemWalks.push({
        api: hook,
        target,
        extensionOwned: true,
        recursive: String(target).includes("**"),
        rsgl: isRsglScanEvent({ target, recursive: String(target).includes("**") })
      });
    },
    onHookInstalled(hook) {
      installedHooks.push(hook);
    },
    onWarning(warning) {
      events.instrumentationWarnings.push(warning);
    }
  });
  Module._load = function instrumentedModuleLoad(request, parent, isMain) {
    const value = String(request);
    const parentFileName = parent?.filename;
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      // Preserve Module._load as the authority for the actual resolution error.
    }
    const started = performance.now();
    try {
      const result = original.apply(this, arguments);
      targetVscodeApi.observeModuleLoad(value, parentFileName, result);
      return result;
    } finally {
      const event = {
        request: sanitize(value),
        resolved: sanitize(resolved),
        parent: sanitize(parentFileName),
        durationMilliseconds: performance.now() - started
      };
      event.rsgl = isRsglModuleLoadEvent(event);
      events.moduleLoads.push(event);
    }
  };
  installedHooks.push("Module._load");
  return () => {
    try {
      Module._load = original;
    } catch (error) {
      events.instrumentationWarnings.push({
        hook: "Module._load",
        message: serializeError(error).message
      });
    }
    targetVscodeApi.stop();
  };
}

function instrumentProcessStarts(events, installedHooks) {
  const originals = new Map();
  for (const api of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"]) {
    const original = childProcess[api];
    originals.set(api, original);
    childProcess[api] = function instrumentedProcessStart(...args) {
      const eventArguments = sanitizeArguments(args);
      const caller = captureCaller();
      const event = {
        api,
        arguments: eventArguments,
        caller: sanitize(caller),
        extensionOwned: isExtensionOwnedCaller(caller),
        rsgl: eventArguments.some(isRsglRuntimePath) || isRsglRuntimePath(caller)
      };
      events.push(event);
      const result = original.apply(this, args);
      event.pid = result?.pid;
      return result;
    };
    installedHooks.push(`child_process.${api}`);
  }
  return () => {
    for (const [api, original] of originals) {
      childProcess[api] = original;
    }
  };
}

function instrumentWorkers(events, installedHooks, warnings) {
  const OriginalWorker = workerThreads.Worker;
  try {
    function InstrumentedWorker(...args) {
      const eventArguments = sanitizeArguments(args);
      const caller = captureCaller();
      events.push({
        arguments: eventArguments,
        caller: sanitize(caller),
        extensionOwned: isExtensionOwnedCaller(caller),
        rsgl: eventArguments.some(isRsglRuntimePath) || isRsglRuntimePath(caller)
      });
      return Reflect.construct(OriginalWorker, args, new.target || OriginalWorker);
    }
    Object.setPrototypeOf(InstrumentedWorker, OriginalWorker);
    InstrumentedWorker.prototype = OriginalWorker.prototype;
    workerThreads.Worker = InstrumentedWorker;
    installedHooks.push("worker_threads.Worker");
    return () => {
      workerThreads.Worker = OriginalWorker;
    };
  } catch (error) {
    warnings.push({ hook: "worker_threads.Worker", message: serializeError(error).message });
    return () => undefined;
  }
}

function instrumentFilesystemWalks(events, installedHooks, warnings) {
  const restorers = [];
  for (const [owner, ownerName, apis] of [
    [fs, "fs", ["readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync"]],
    [fs.promises, "fs.promises", ["readdir", "opendir", "glob"]]
  ]) {
    for (const api of apis) {
      const original = owner[api];
      if (typeof original !== "function") {
        continue;
      }
      try {
        owner[api] = function instrumentedFilesystemWalk(...args) {
          const target = displayTarget(args[0]);
          const rawCaller = captureCaller();
          const event = {
            api: `${ownerName}.${api}`,
            target,
            caller: sanitize(rawCaller),
            extensionOwned: isExtensionOwnedCaller(rawCaller),
            recursive: isRecursiveWalk(api, args, target)
          };
          event.rsgl = isRsglScanEvent(event);
          events.push(event);
          return original.apply(this, args);
        };
        installedHooks.push(`${ownerName}.${api}`);
        restorers.push(() => {
          owner[api] = original;
        });
      } catch (error) {
        warnings.push({ hook: `${ownerName}.${api}`, message: serializeError(error).message });
      }
    }
  }
  return () => restorers.reverse().forEach(restore => restore());
}

function rsglHostLoaded() {
  return Object.keys(require.cache).some(fileName =>
    /bundle[\\/]features[\\/]rsglHost\.js$/i.test(fileName)
  );
}

function isRecursiveWalk(api, args, target) {
  if (api === "glob" || api === "globSync") {
    return String(target).includes("**");
  }
  return args.slice(1).some(value =>
    value && typeof value === "object" && value.recursive === true);
}

function captureCaller() {
  return new Error("activation-probe-callsite").stack ?? "";
}

function isExtensionOwnedCaller(value) {
  const normalize = candidate => process.platform === "win32"
    ? candidate.replaceAll("\\", "/").toLowerCase()
    : candidate.replaceAll("\\", "/");
  return normalize(value).includes(normalize(extensionRoot));
}

function sanitizeArguments(args) {
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

function displayTarget(value) {
  if (typeof value === "string") {
    return sanitize(value);
  }
  if (value instanceof URL) {
    return sanitize(value.href);
  }
  if (value && typeof value === "object") {
    if (typeof value.pattern === "string") {
      return sanitize(value.pattern);
    }
    if (typeof value.fsPath === "string") {
      return sanitize(value.fsPath);
    }
    if (typeof value.toString === "function") {
      return sanitize(value.toString());
    }
  }
  return String(value);
}

function sanitize(value) {
  return redactActivationPaths(value, [
    [workspaceRoot, "<workspace>"],
    [sourceWorkspace, "<source-workspace>"],
    [extensionRoot, "<extension>"]
  ]);
}

function settle(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function canonicalPath(value) {
  return fs.realpathSync.native(path.resolve(value));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

function writeSample(sample) {
  fs.writeFileSync(sampleOutput, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

module.exports = { run };
