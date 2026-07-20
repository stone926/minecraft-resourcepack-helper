#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createActivationTelemetry,
  installNodeActivationInstrumentation
} from "./instrumentation.mjs";
import { activationProbeSampleSchemaVersion } from "./schema.mjs";
import {
  createExtensionContext,
  createVscodeStub,
  disposeExtensionContext
} from "./vscode-stub.mjs";

const scriptFile = fileURLToPath(import.meta.url);

export async function runNodeBundleActivationSample(options) {
  const bundlePath = path.resolve(options.bundlePath);
  const extensionRoot = path.resolve(options.extensionRoot);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const telemetry = createActivationTelemetry({ extensionRoot, workspaceRoot });
  const vscode = createVscodeStub({ workspaceRoot, telemetry });
  const context = createExtensionContext(extensionRoot, vscode, {
    storagePath: path.join(workspaceRoot, ".activation-probe-storage")
  });
  let instrumentation;
  let status = "ok";
  let error;

  collectGarbage();
  const rssBeforeBytes = process.memoryUsage.rss();
  const startedAt = performance.now();
  try {
    instrumentation = installNodeActivationInstrumentation({ telemetry, vscode });
    const extension = createRequire(import.meta.url)(bundlePath);
    if (typeof extension?.activate !== "function") {
      throw new Error(`Extension bundle does not export activate(): ${bundlePath}`);
    }
    await extension.activate(context);
  } catch (caught) {
    status = "error";
    error = serializeError(caught, { extensionRoot, workspaceRoot });
  }
  const activationMilliseconds = performance.now() - startedAt;
  const rssAfterActivationBytes = process.memoryUsage.rss();
  await settle(options.settleMilliseconds);
  collectGarbage();
  const steadyRssBytes = process.memoryUsage.rss();
  const events = telemetry.snapshot();
  const installedHooks = instrumentation?.installedHooks ?? [];
  instrumentation?.stop();

  try {
    disposeExtensionContext(context);
  } catch (caught) {
    if (status === "ok") {
      status = "error";
      error = serializeError(caught, { extensionRoot, workspaceRoot });
    }
  }

  return Object.freeze({
    schemaVersion: activationProbeSampleSchemaVersion,
    adapter: "node-bundle",
    iteration: options.iteration,
    status,
    error,
    activationMilliseconds,
    rssBeforeBytes,
    rssAfterActivationBytes,
    steadyRssBytes,
    rssDeltaBytes: steadyRssBytes - rssBeforeBytes,
    installedHooks,
    ...events
  });
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Invalid node bundle activation sample arguments.");
    }
    if (values.has(flag)) {
      throw new Error(`${flag} may only be specified once.`);
    }
    values.set(flag, value);
  }
  for (const required of ["--bundle", "--extension-root", "--workspace", "--iteration", "--settle-ms", "--sample-out"]) {
    if (!values.has(required)) {
      throw new Error(`Missing required node bundle activation sample argument: ${required}`);
    }
  }
  const iteration = parseInteger(values.get("--iteration"), "--iteration", 0, 10_000);
  const settleMilliseconds = parseInteger(values.get("--settle-ms"), "--settle-ms", 0, 60_000);
  return {
    bundlePath: values.get("--bundle"),
    extensionRoot: values.get("--extension-root"),
    workspaceRoot: values.get("--workspace"),
    iteration,
    settleMilliseconds,
    sampleOutput: path.resolve(values.get("--sample-out"))
  };
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

async function settle(milliseconds) {
  await new Promise(resolve => setImmediate(resolve));
  if (milliseconds > 0) {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
  }
}

function collectGarbage() {
  globalThis.gc?.();
}

function serializeError(error, roots) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    message: sanitizeMessage(message, roots)
  };
}

function sanitizeMessage(message, roots) {
  let sanitized = message;
  for (const [label, root] of [["<extension>", roots.extensionRoot], ["<workspace>", roots.workspaceRoot]]) {
    sanitized = sanitized.replaceAll(root, label).replaceAll(root.replaceAll("\\", "/"), label);
  }
  return sanitized;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? invoked.toLowerCase() === scriptFile.toLowerCase()
    : invoked === scriptFile;
}

if (isMainModule()) {
  let exitCode = 0;
  try {
    const options = parseArguments(process.argv.slice(2));
    const sample = await runNodeBundleActivationSample(options);
    writeFileSync(options.sampleOutput, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
    exitCode = sample.status === "ok" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    exitCode = 1;
  }
  process.exit(exitCode);
}
