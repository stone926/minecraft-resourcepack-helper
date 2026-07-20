const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "stone926.minecraft-resourcepack-helper";
const resultFile = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_RESULT");
const workspaceRoot = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_WORKSPACE");
const extensionRoot = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_EXTENSION_ROOT");

async function run() {
  const processStarts = [];
  const restoreProcessInstrumentation = instrumentProcessStarts(processStarts);
  const result = {
    schemaVersion: 1,
    extensionId,
    stages: [],
    processStarts,
    childPids: []
  };

  try {
    await vscode.workspace.getConfiguration("McResHelper").update(
      "rsgl.enabled",
      "off",
      vscode.ConfigurationTarget.Workspace
    );
    const extension = vscode.extensions.getExtension(extensionId);
    assert(extension, `Packaged extension '${extensionId}' is not installed.`);
    await extension.activate();
    fs.writeFileSync(path.join(workspaceRoot, "pack.mcmeta"), JSON.stringify({
      pack: { pack_format: 75, description: "Packaged smoke" }
    }), "utf8");
    result.stages.push("activated-off");

    const modelUri = vscode.Uri.file(path.join(
      workspaceRoot,
      "assets",
      "smoke",
      "models",
      "block",
      "cube.json"
    ));
    await showDocument(modelUri);
    await settle(250);
    assert(!rsglHostLoaded(), "JSON-only activation loaded the lazy RSGL host bundle.");
    assertNoExtensionProcessStarts(processStarts, "JSON-only activation");
    result.stages.push("json-only-cold");

    const rsglUri = vscode.Uri.file(path.join(workspaceRoot, "rsgl", "main.rsgl"));
    await showDocument(rsglUri);
    await settle(300);
    assert(!rsglHostLoaded(), "McResHelper.rsgl.enabled=off loaded the RSGL host.");
    assertNoExtensionProcessStarts(processStarts, "McResHelper.rsgl.enabled=off");
    result.stages.push("rsgl-off");

    await vscode.workspace.getConfiguration("McResHelper").update(
      "rsgl.enabled",
      "auto",
      vscode.ConfigurationTarget.Workspace
    );
    await Promise.all([
      vscode.commands.executeCommand("rsgl.refreshWorkspace"),
      waitForRsglCompletion(rsglUri)
    ]);
    await waitUntil(rsglHostLoaded, "Timed out waiting for the packaged RSGL host bundle.");
    const lspStarts = processStarts.filter(start =>
      start.arguments.some(argument => /bundle[\\/]rsgl[\\/]server\.js$/i.test(argument))
    );
    assert(lspStarts.length === 1, `Expected one packaged LSP start, got ${lspStarts.length}.`);
    result.stages.push("rsgl-auto-single-flight");

    const pngDataUri = await vscode.commands.executeCommand(
      "McResHelper.captureModelPreviewImage",
      modelUri,
      { width: 192, height: 192, transparentBackground: true }
    );
    assert(
      typeof pngDataUri === "string" && pngDataUri.startsWith("data:image/png;base64,iVBORw0KGgo"),
      "Packaged model preview did not return a PNG screenshot."
    );
    result.screenshotBytes = Buffer.from(pngDataUri.slice(pngDataUri.indexOf(",") + 1), "base64").byteLength;
    assert(result.screenshotBytes > 100, "Packaged model preview screenshot is unexpectedly empty.");
    result.screenshotDataUri = pngDataUri;
    result.stages.push("model-preview-rendered");

    const alternatePng = await vscode.commands.executeCommand(
      "McResHelper.captureModelPreviewImage",
      modelUri,
      {
        width: 192,
        height: 192,
        transparentBackground: false,
        backgroundColor: "#123456",
        includeGrid: true,
        includeAxes: true
      }
    );
    assert(
      typeof alternatePng === "string" && alternatePng.startsWith("data:image/png;base64,iVBORw0KGgo"),
      "Packaged model preview interaction capture did not return a PNG."
    );
    assert(alternatePng !== pngDataUri, "Model preview screenshot controls did not affect rendering.");
    result.stages.push("model-preview-interaction");

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await settle(250);
    result.stages.push("model-preview-disposed");
    finalizeProcessAttribution(result, processStarts);
    writeResult(result);
  } catch (error) {
    result.error = serializeError(error);
    finalizeProcessAttribution(result, processStarts);
    writeResult(result);
    throw error;
  } finally {
    restoreProcessInstrumentation();
  }
}

async function waitForRsglCompletion(uri) {
  return waitUntil(async () => {
    const items = await vscode.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      uri,
      new vscode.Position(1, 0)
    );
    return Boolean(items && Array.isArray(items.items) && items.items.length > 0);
  }, "Timed out waiting for packaged RSGL completion.", 30_000);
}

async function showDocument(uri) {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

function rsglHostLoaded() {
  return Object.keys(require.cache).some(fileName =>
    /bundle[\\/]features[\\/]rsglHost\.js$/i.test(fileName)
  );
}

function instrumentProcessStarts(events) {
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
      event.attribution = event.rsgl
        ? "rsgl"
        : event.extensionOwned
          ? "extension"
          : "hostNoise";
      events.push(event);
      const child = original.apply(this, args);
      event.pid = child?.pid;
      return child;
    };
  }
  return () => {
    for (const [api, original] of originals) {
      childProcess[api] = original;
    }
  };
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

function captureCaller() {
  return new Error("packaged-extension-host-smoke-callsite").stack ?? "";
}

function isExtensionOwnedCaller(value) {
  const normalize = candidate => process.platform === "win32"
    ? candidate.replaceAll("\\", "/").toLowerCase()
    : candidate.replaceAll("\\", "/");
  return normalize(value).includes(normalize(extensionRoot));
}

function isRsglRuntimePath(value) {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/bundle/features/rsglhost.js")
    || normalized.includes("/bundle/rsgl/server.js")
    || normalized.includes("/bundle/rsgl/worker.js")
    || /\/packages\/rsgl-(?:core|lsp|shared)(?:\/|$)/.test(normalized);
}

function sanitize(value) {
  return String(value)
    .replaceAll(workspaceRoot, "<workspace>")
    .replaceAll(extensionRoot, "<extension>");
}

function assertNoExtensionProcessStarts(events, label) {
  const owned = events.filter(event => event.extensionOwned || event.rsgl);
  assert(
    owned.length === 0,
    `${label} started ${owned.length} extension-owned or RSGL child process(es): ${JSON.stringify(owned)}`
  );
}

function finalizeProcessAttribution(result, processStarts) {
  result.processAttribution = {
    rsgl: processStarts.filter(start => start.attribution === "rsgl"),
    extension: processStarts.filter(start => start.attribution === "extension"),
    hostNoise: processStarts.filter(start => start.attribution === "hostNoise")
  };
  result.childPids = [...new Set(processStarts
    .filter(start => start.extensionOwned || start.rsgl)
    .map(start => start.pid)
    .filter(Number.isInteger))];
}

async function waitUntil(predicate, message, timeout = 15_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await settle(100);
  }
  throw new Error(lastError ? `${message} ${serializeError(lastError).message}` : message);
}

function settle(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function writeResult(result) {
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
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

module.exports = { run };
