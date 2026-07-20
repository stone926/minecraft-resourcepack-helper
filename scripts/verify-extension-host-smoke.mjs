#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  codeInvocation,
  resolveCodeExecutable
} from "./extension-host-harness.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), "..");
const extensionTestPath = path.join(repositoryRoot, "scripts", "extension-host-smoke", "run.cjs");
const require = createRequire(import.meta.url);
const { createCheckerTexturePng } = require("./extension-host-smoke/png.cjs");

export function runPackagedExtensionHostSmoke(extensionRoot, options = {}) {
  const resolvedExtensionRoot = path.resolve(extensionRoot);
  if (!existsSync(path.join(resolvedExtensionRoot, "bundle", "extension.js"))) {
    throw new Error(`Packaged extension root is invalid: ${resolvedExtensionRoot}`);
  }
  const codeExecutable = resolveCodeExecutable(options.codeExecutable);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "mcres-extension-host-smoke-"));
  const workspaceRoot = path.join(temporaryRoot, "工作区 with spaces");
  const resultFile = path.join(temporaryRoot, "extension-host-result.json");
  try {
    createFixture(workspaceRoot);
    const invocation = codeInvocation(codeExecutable, [
      `--user-data-dir=${path.join(temporaryRoot, "user data")}`,
      `--extensions-dir=${path.join(temporaryRoot, "extensions")}`,
      `--extensionDevelopmentPath=${resolvedExtensionRoot}`,
      `--extensionTestsPath=${extensionTestPath}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      workspaceRoot
    ]);
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMilliseconds ?? 120_000,
      env: {
        ...process.env,
        MCRES_EXTENSION_HOST_SMOKE_RESULT: resultFile,
        MCRES_EXTENSION_HOST_SMOKE_WORKSPACE: workspaceRoot,
        MCRES_EXTENSION_HOST_SMOKE_EXTENSION_ROOT: resolvedExtensionRoot
      }
    });
    if (result.error || result.status !== 0) {
      throw new Error([
        "Packaged Extension Host smoke failed.",
        result.error?.message,
        result.stdout,
        result.stderr,
        existsSync(resultFile) ? readFileSync(resultFile, "utf8") : undefined
      ].filter(Boolean).join("\n"));
    }
    if (!existsSync(resultFile)) {
      throw new Error("Packaged Extension Host smoke exited without a result file.");
    }
    const report = JSON.parse(readFileSync(resultFile, "utf8"));
    if (report.error || !report.stages?.includes("model-preview-disposed")) {
      throw new Error(`Packaged Extension Host smoke returned an incomplete report: ${JSON.stringify(report)}`);
    }
    writeScreenshot(options.screenshotOutput, report.screenshotDataUri);
    writeScreenshot(options.fallbackScreenshotOutput, report.fallbackScreenshotDataUri);
    delete report.screenshotDataUri;
    delete report.fallbackScreenshotDataUri;
    assertChildrenExited(report.childPids ?? []);
    return report;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function writeScreenshot(outputFile, dataUri) {
  if (!outputFile || typeof dataUri !== "string") {
    return;
  }
  const comma = dataUri.indexOf(",");
  if (comma < 0) {
    throw new Error("Extension Host smoke returned an invalid screenshot data URI.");
  }
  const screenshotOutput = path.resolve(outputFile);
  mkdirSync(path.dirname(screenshotOutput), { recursive: true });
  writeFileSync(screenshotOutput, Buffer.from(dataUri.slice(comma + 1), "base64"));
}

function createFixture(root) {
  const modelDirectory = path.join(root, "assets", "smoke", "models", "block");
  const textureDirectory = path.join(root, "assets", "smoke", "textures", "block");
  const rsglDirectory = path.join(root, "rsgl");
  mkdirSync(modelDirectory, { recursive: true });
  mkdirSync(textureDirectory, { recursive: true });
  mkdirSync(rsglDirectory, { recursive: true });
  writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
    root: "rsgl",
    outDir: ".",
    namespace: "smoke",
    target: { edition: "java", format: [75, 0] }
  }), "utf8");
  writeFileSync(path.join(rsglDirectory, "main.rsgl"), [
    "import { generatedItemModel } from \"rsgl:conventions/items.rsgl\"",
    "model block generated_smoke {}",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(modelDirectory, "cube.json"), JSON.stringify(cubeModel("smoke:block/checker")), "utf8");
  writeFileSync(path.join(modelDirectory, "broken.json"), JSON.stringify(cubeModel("smoke:block/broken")), "utf8");
  writeFileSync(
    path.join(textureDirectory, "checker.png"),
    createCheckerTexturePng()
  );
  writeFileSync(path.join(textureDirectory, "broken.png"), "not a PNG", "utf8");
}

function cubeModel(texture) {
  return {
    textures: { all: texture },
    elements: [{
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: {
        north: { texture: "#all" },
        south: { texture: "#all" },
        east: { texture: "#all" },
        west: { texture: "#all" },
        up: { texture: "#all" },
        down: { texture: "#all" }
      }
    }]
  };
}

function assertChildrenExited(pids) {
  let alive = pids.filter(pid => isProcessAlive(pid));
  const deadline = Date.now() + 5_000;
  while (alive.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    alive = alive.filter(pid => isProcessAlive(pid));
  }
  if (alive.length > 0) {
    throw new Error(
      `Packaged Extension Host left extension-owned or RSGL child processes alive: ${alive.join(", ")}`
    );
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === scriptFile;
}

if (isMainModule()) {
  const [extensionRoot, codeExecutable, screenshotOutput] = process.argv.slice(2);
  if (!extensionRoot) {
    throw new Error(
      "Usage: verify-extension-host-smoke.mjs <extracted-extension-root> [code-executable] [screenshot-output]"
    );
  }
  const report = runPackagedExtensionHostSmoke(extensionRoot, { codeExecutable, screenshotOutput });
  console.log(`Packaged Extension Host smoke passed (${report.screenshotBytes} screenshot bytes).`);
}
