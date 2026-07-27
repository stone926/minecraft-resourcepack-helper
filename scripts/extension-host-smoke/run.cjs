const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const {
  assert,
  createExtensionOwnedCallerPredicate,
  instrumentProcessStarts,
  isRsglOwnedPath,
  requiredEnvironment,
  rsglHostLoaded,
  serializeError,
  settle
} = require("../activation-probe/lib/instrumentation-core.cjs");
const {
  analyzeRenderedModelPng,
  assertRenderedCheckerTexture,
  assertRenderedMissingTexture
} = require("./png.cjs");

const extensionId = "stone926.minecraft-resourcepack-helper";
const resultFile = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_RESULT");
const workspaceRoot = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_WORKSPACE");
const extensionRoot = requiredEnvironment("MCRES_EXTENSION_HOST_SMOKE_EXTENSION_ROOT");
const isExtensionOwnedCaller = createExtensionOwnedCallerPredicate(extensionRoot);
const isRsglRuntimePath = isRsglOwnedPath;

async function run() {
  const processStarts = [];
  const restoreProcessInstrumentation = instrumentProcessStarts(childProcess, processStarts, {
    sanitize,
    isExtensionOwnedCaller,
    isRsglRuntimePath,
    callsiteLabel: "packaged-extension-host-smoke-callsite",
    decorateEvent: event => {
      event.attribution = event.rsgl
        ? "rsgl"
        : event.extensionOwned
          ? "extension"
          : "hostNoise";
    }
  });
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
      {
        width: 192,
        height: 192,
        transparentBackground: true,
        includeGrid: false,
        includeAxes: false
      }
    );
    assert(
      typeof pngDataUri === "string" && pngDataUri.startsWith("data:image/png;base64,iVBORw0KGgo"),
      "Packaged model preview did not return a PNG screenshot."
    );
    const screenshotBytes = Buffer.from(pngDataUri.slice(pngDataUri.indexOf(",") + 1), "base64");
    result.screenshotBytes = screenshotBytes.byteLength;
    assert(result.screenshotBytes > 100, "Packaged model preview screenshot is unexpectedly empty.");
    result.screenshotAnalysis = analyzeRenderedModelPng(screenshotBytes);
    assertRenderedCheckerTexture(result.screenshotAnalysis);
    result.screenshotDataUri = pngDataUri;
    result.stages.push("model-preview-rendered");

    const brokenModelUri = vscode.Uri.file(path.join(
      workspaceRoot,
      "assets",
      "smoke",
      "models",
      "block",
      "broken.json"
    ));
    const fallbackPng = await vscode.commands.executeCommand(
      "McResHelper.captureModelPreviewImage",
      brokenModelUri,
      {
        width: 192,
        height: 192,
        transparentBackground: true,
        includeGrid: false,
        includeAxes: false
      }
    );
    assert(
      typeof fallbackPng === "string" && fallbackPng.startsWith("data:image/png;base64,iVBORw0KGgo"),
      "Packaged model preview texture-fallback capture did not return a PNG."
    );
    result.fallbackScreenshotAnalysis = analyzeRenderedModelPng(
      Buffer.from(fallbackPng.slice(fallbackPng.indexOf(",") + 1), "base64")
    );
    assertRenderedMissingTexture(result.fallbackScreenshotAnalysis);
    result.fallbackScreenshotDataUri = fallbackPng;
    result.stages.push("model-preview-texture-fallback");

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

function writeResult(result) {
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

module.exports = { run };
