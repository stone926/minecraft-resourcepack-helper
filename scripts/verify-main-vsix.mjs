#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { prepareVsixExtension } from "./activation-probe/prepared-vsix.mjs";
import { runPackagedExtensionHostSmoke } from "./verify-extension-host-smoke.mjs";
import {
  combinedVsixRuntimeEntries,
  combinedVsixRuntimeSourceMaps
} from "./combined-vsix-layout.mjs";

const { vsixArgument, comparisonDevelopment } = parseArguments(process.argv.slice(2));

const vsixPath = path.resolve(vsixArgument);
if (!existsSync(vsixPath)) {
  fail(`Combined VSIX does not exist: ${vsixPath}`);
}

// The prepared cache adds two digest path segments. Keep the disposable prefix
// short so spawned Windows runtimes retain legacy MAX_PATH headroom.
const extractionRoot = mkdtempSync(path.join(tmpdir(), "v-"));
try {
  const unicodeInstallRoot = path.join(extractionRoot, "安装 x");
  mkdirSync(unicodeInstallRoot, { recursive: true });
  const prepared = await prepareVsixExtension({
    artifactPath: vsixPath,
    repositoryRoot: unicodeInstallRoot
  });
  const extensionRoot = prepared.extensionRoot;
  const fixtureRoot = path.join(extractionRoot, "工作区 fixture with spaces");
  mkdirSync(fixtureRoot, { recursive: true });
  verifyCombinedRuntimePayload(extensionRoot, { comparisonDevelopment });
  await verifyLanguageServer(extensionRoot, fixtureRoot);
  await verifyBuildWorker(extensionRoot, fixtureRoot);
  const extensionHost = runPackagedExtensionHostSmoke(extensionRoot);
  if (!extensionHost.stages.includes("rsgl-auto-single-flight")) {
    fail("Packaged Extension Host smoke did not exercise the lazy RSGL runtime.");
  }
  console.log(`Combined VSIX runtime smoke passed: ${vsixPath}`);
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}

function verifyCombinedRuntimePayload(extensionRoot, options) {
  const manifest = readJson(path.join(extensionRoot, "package.json"), "published package.json");
  if (manifest.main !== `./${combinedVsixRuntimeEntries.root}`) {
    fail(`Published main entry is not the isolated root bundle: ${String(manifest.main)}`);
  }
  if (!Array.isArray(manifest.extensionKind) || manifest.extensionKind.join(",") !== "workspace") {
    fail("Published extensionKind must be exactly ['workspace'].");
  }
  if ("extensionPack" in manifest) {
    fail("Published manifest must not retain the removed RSGL extensionPack.");
  }
  if (manifest.dependencies || manifest.devDependencies || manifest.scripts?.["vscode:prepublish"]) {
    fail("Published manifest retained package-manager or rebuild metadata outside the allow-list.");
  }
  const rsglLanguage = manifest.contributes?.languages?.find(language => language.id === "rsgl");
  const rsglGrammar = manifest.contributes?.grammars?.find(grammar => grammar.language === "rsgl");
  const rsglCommands = manifest.contributes?.commands
    ?.filter(command => typeof command.command === "string" && command.command.startsWith("rsgl.")) ?? [];
  if (rsglLanguage?.configuration !== "./language-configuration/rsgl.json"
    || rsglGrammar?.path !== "./syntaxes/rsgl.tmLanguage.json"
    || rsglCommands.length === 0) {
    fail("Published root manifest does not own the complete RSGL language surface.");
  }

  for (const alternatives of [
    ["package.json"],
    ["package.nls.json"],
    ["README.md", "readme.md"],
    ["README_CN.md", "readme_cn.md"],
    ...Object.values(combinedVsixRuntimeEntries).map(entryPath => [entryPath]),
    ["webviews/modelPreview/styles.css"],
    ["language-configuration/rsgl.json"],
    ["syntaxes/rsgl.tmLanguage.json"],
    ["schemas/en/rsgl-config.schema.json"],
    ["schemas/zh-cn/rsgl-config.schema.json"],
    ["l10n/bundle.l10n.json"],
    ["licenses/THREE-LICENSE.txt"]
  ]) {
    if (!alternatives.some(relativePath => existsSync(path.join(
      extensionRoot,
      ...relativePath.split("/")
    )))) {
      fail(`Combined VSIX is missing required runtime payload: ${alternatives.join(" or ")}`);
    }
  }
  const stdlibRoot = path.join(extensionRoot, "bundle", "rsgl", "stdlib");
  if (!existsSync(stdlibRoot)) {
    fail(`Combined VSIX is missing the RSGL stdlib: ${stdlibRoot}`);
  }
  const stdlibFiles = listFiles(stdlibRoot).filter(relativePath => relativePath.endsWith(".rsgl"));
  if (stdlibFiles.length === 0) {
    fail("Combined VSIX contains an empty RSGL stdlib directory.");
  }

  const payloadFiles = listFiles(extensionRoot);
  const expectedSourceMaps = options.comparisonDevelopment
    ? [...combinedVsixRuntimeSourceMaps]
    : [];
  const actualSourceMaps = payloadFiles.filter(relativePath => /\.map$/i.test(relativePath));
  if (JSON.stringify(actualSourceMaps) !== JSON.stringify(expectedSourceMaps)) {
    fail(
      "Combined VSIX source maps do not match the requested verification mode:\n"
      + actualSourceMaps.join("\n")
    );
  }
  const allowedSourceMaps = new Set(expectedSourceMaps);
  const forbidden = payloadFiles.filter(relativePath =>
    /(?:^|\/)node_modules\//.test(relativePath)
    || /(?:^|\/)(?:src|test|tests|fixtures|packages|extensions|out|dist|vendor)\//.test(relativePath)
    || (/\.map$/i.test(relativePath) && !allowedSourceMaps.has(relativePath))
    || /\.(?:ts|tsx)$/i.test(relativePath)
    || /\.test\.[^/]+$/i.test(relativePath)
    || (/^webviews\/modelPreview\//.test(relativePath)
      && relativePath !== "webviews/modelPreview/styles.css")
  );
  if (forbidden.length > 0) {
    fail(`Combined VSIX contains forbidden development/runtime-source payload:\n${forbidden.join("\n")}`);
  }
}

function parseArguments(args) {
  let vsixArgument;
  let comparisonDevelopment = false;
  for (const argument of args) {
    if (argument === "--comparison-development") {
      if (comparisonDevelopment) {
        fail("--comparison-development may only be specified once.");
      }
      comparisonDevelopment = true;
      continue;
    }
    if (argument.startsWith("--") || vsixArgument !== undefined) {
      fail(`Unknown combined VSIX verification argument: ${argument}`);
    }
    vsixArgument = argument;
  }
  if (!vsixArgument) {
    fail(
      "Usage: node scripts/verify-main-vsix.mjs <path-to-combined.vsix> "
      + "[--comparison-development]"
    );
  }
  return { vsixArgument, comparisonDevelopment };
}

async function verifyLanguageServer(extensionRoot, fixtureRoot) {
  const serverModule = path.join(
    extensionRoot,
    "bundle",
    "rsgl",
    "server.js",
  );
  if (!existsSync(serverModule)) {
    fail(`Combined VSIX is missing its language server entry point: ${serverModule}`);
  }

  const child = spawn(process.execPath, [serverModule, "--stdio"], {
    cwd: extensionRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const protocol = createProtocolReader(child);
  const stdlibRoot = path.join(extensionRoot, "bundle", "rsgl", "stdlib");
  const sourceFile = path.join(fixtureRoot, "stdlib import smoke.rsgl");
  const sourceText = [
    "import { generatedItemModel } from \"rsgl:conventions/items.rsgl\"",
    "model block packaged_lsp_smoke {}"
  ].join("\n");
  writeFileSync(sourceFile, sourceText, "utf8");
  const sourceUri = pathToFileURL(sourceFile).href;
  const fixtureUri = pathToFileURL(fixtureRoot).href;

  try {
    const initializeResponse = protocol.waitForResponse(1);
    child.stdin.write(frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: fixtureUri,
        workspaceFolders: [{ uri: fixtureUri, name: "packaged smoke" }],
        capabilities: {},
        initializationOptions: {
          stdlibRoot,
          defaultAssetsPath: null,
          resourcePackRoots: [],
          workspaceFolders: [{
            workspaceFolderPath: fixtureRoot,
            defaultAssetsPath: null,
            resourcePackRoots: []
          }]
        },
      },
    }));
    const initializeResult = assertSuccessfulResponse(await initializeResponse, 1);
    if (!initializeResult?.capabilities) {
      fail("RSGL language server initialize response did not include capabilities.");
    }

    child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));
    const diagnosticsNotification = protocol.waitForNotification(
      "textDocument/publishDiagnostics",
      message => message?.params?.uri === sourceUri
    );
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: sourceUri,
          languageId: "rsgl",
          version: 1,
          text: sourceText
        }
      }
    }));
    const diagnostics = (await diagnosticsNotification)?.params?.diagnostics;
    if (!Array.isArray(diagnostics)) {
      fail("RSGL language server did not publish diagnostics for the packaged stdlib fixture.");
    }
    const errors = diagnostics.filter(diagnostic => diagnostic?.severity === 1);
    if (errors.length > 0) {
      fail(`Packaged LSP could not compile the explicit-stdlib fixture: ${JSON.stringify(errors)}`);
    }

    const shutdownResponse = protocol.waitForResponse(2);
    child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
    assertSuccessfulResponse(await shutdownResponse, 2);

    child.stdin.end(frame({ jsonrpc: "2.0", method: "exit", params: null }));
    const exit = await protocol.waitForExit();
    if (exit.code !== 0) {
      fail(`RSGL language server exited with code ${exit.code}.\n${exit.stderr}`);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

async function verifyBuildWorker(extensionRoot, fixtureRoot) {
  const workerPath = path.join(extensionRoot, "bundle", "rsgl", "worker.js");
  const stdlibRoot = path.join(extensionRoot, "bundle", "rsgl", "stdlib");
  const sourceRoot = path.join(fixtureRoot, "worker sources");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, "main.rsgl"), "model block packaged_worker_smoke {}\n", "utf8");

  const payload = {
    sourceRoot,
    validationAnchor: sourceRoot,
    stdlibRoot,
    defaultAssetsPath: null,
    resourcePackRoots: [],
    sourceMaps: false,
    manifest: false
  };
  const compiled = await runWorkerRequest(workerPath, {
    kind: "compileDirectory",
    payload
  });
  if (compiled?.type !== "success" || compiled.kind !== "compileDirectory" || !compiled.result?.success) {
    fail(`Packaged RSGL worker compile failed: ${JSON.stringify(compiled)}`);
  }
  if (!compiled.result.emittedFiles?.some(file =>
    file.outputPath === "assets/minecraft/models/block/packaged_worker_smoke.json")) {
    fail("Packaged RSGL worker did not emit the expected resource.");
  }

  const cancelled = await runWorkerRequest(workerPath, {
    kind: "compileDirectory",
    payload
  }, true);
  if (cancelled?.type !== "cancelled") {
    fail(`Packaged RSGL worker did not honor cancellation: ${JSON.stringify(cancelled)}`);
  }
}

function runWorkerRequest(workerPath, request, cancelled = false) {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  if (cancelled) {
    Atomics.store(state, 0, 1);
  }
  return withTimeout(new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    let settled = false;
    worker.once("message", message => {
      settled = true;
      resolve(message);
      void worker.terminate();
    });
    worker.once("error", error => {
      settled = true;
      reject(error);
    });
    worker.once("exit", code => {
      if (!settled) {
        settled = true;
        reject(new Error(`Packaged RSGL worker exited before responding (code ${code}).`));
      }
    });
    worker.postMessage({
      request,
      cancellationBuffer: state.buffer
    });
  }), "Timed out waiting for the packaged RSGL worker.");
}

function createProtocolReader(child) {
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let exitResult = null;
  let terminalError = null;
  const responses = new Map();
  const waiters = new Map();
  const notifications = [];
  const notificationWaiters = [];
  const exitWaiters = [];

  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    readMessages();
  });
  child.stderr.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", error => finishWithError(error));
  child.on("exit", (code, signal) => {
    exitResult = { code, signal, stderr };
    for (const resolve of exitWaiters.splice(0)) {
      resolve(exitResult);
    }
    if (code !== 0) {
      finishWithError(new Error(`Language server exited with code ${code}.\n${stderr}`));
    }
  });

  return {
    waitForResponse(id) {
      if (responses.has(id)) {
        return Promise.resolve(responses.get(id));
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      return withTimeout(new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
      }), `Timed out waiting for LSP response ${id}.`);
    },
    waitForNotification(method, predicate = () => true) {
      const existingIndex = notifications.findIndex(message =>
        message?.method === method && predicate(message));
      if (existingIndex >= 0) {
        return Promise.resolve(notifications.splice(existingIndex, 1)[0]);
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      return withTimeout(new Promise((resolve, reject) => {
        notificationWaiters.push({ method, predicate, resolve, reject });
      }), `Timed out waiting for LSP notification ${method}.`);
    },
    waitForExit() {
      if (exitResult) {
        return Promise.resolve(exitResult);
      }
      return withTimeout(new Promise(resolve => exitWaiters.push(resolve)), "Timed out waiting for the RSGL language server to exit.");
    },
  };

  function readMessages() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        finishWithError(new Error(`Invalid LSP response header: ${header}`));
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }
      const payload = buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      let message;
      try {
        message = JSON.parse(payload);
      } catch (error) {
        finishWithError(error);
        return;
      }
      if (message.id === undefined) {
        const waiterIndex = notificationWaiters.findIndex(waiter =>
          waiter.method === message.method && waiter.predicate(message));
        if (waiterIndex >= 0) {
          const [waiter] = notificationWaiters.splice(waiterIndex, 1);
          waiter.resolve(message);
        } else {
          notifications.push(message);
        }
        continue;
      }
      responses.set(message.id, message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  function finishWithError(error) {
    terminalError = error instanceof Error ? error : new Error(String(error));
    for (const waiter of waiters.values()) {
      waiter.reject(terminalError);
    }
    waiters.clear();
    for (const waiter of notificationWaiters.splice(0)) {
      waiter.reject(terminalError);
    }
  }
}

function listFiles(root) {
  const files = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath.replaceAll("\\", "/"));
      }
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function readJson(fileName, label) {
  try {
    return JSON.parse(readFileSync(fileName, "utf8"));
  } catch (error) {
    fail(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function assertSuccessfulResponse(message, id) {
  if (message?.error) {
    fail(`RSGL language server returned an error for request ${id}: ${JSON.stringify(message.error)}`);
  }
  return message?.result;
}

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function fail(message) {
  throw new Error(message);
}
