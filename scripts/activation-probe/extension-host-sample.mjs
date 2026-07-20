#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  codeInvocation,
  extractZipArchive,
  resolveCodeExecutable
} from "../extension-host-harness.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const extensionTestPath = path.join(scriptDirectory, "extension-host-run.cjs");

export function parseExtensionHostSampleArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected Extension Host sample argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (values.has(flag)) {
      throw new Error(`${flag} may only be specified once.`);
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value after ${flag}.`);
    }
    values.set(flag, value);
    if (equals < 0) {
      index += 1;
    }
  }
  const required = ["--artifact", "--workspace", "--iteration", "--settle-ms", "--sample-out"];
  for (const flag of required) {
    if (!values.has(flag)) {
      throw new Error(`Missing required Extension Host sample argument: ${flag}.`);
    }
  }
  for (const flag of values.keys()) {
    if (![...required, "--code"].includes(flag)) {
      throw new Error(`Unknown Extension Host sample argument: ${flag}.`);
    }
  }
  return {
    artifact: path.resolve(values.get("--artifact")),
    workspace: path.resolve(values.get("--workspace")),
    iteration: parseInteger(values.get("--iteration"), "--iteration", 0, 10_000),
    settleMilliseconds: parseInteger(values.get("--settle-ms"), "--settle-ms", 0, 10_000),
    sampleOutput: path.resolve(values.get("--sample-out")),
    codeExecutable: values.has("--code") ? path.resolve(values.get("--code")) : undefined
  };
}

export function runExtensionHostSample(options) {
  assertInput(options.artifact, "artifact");
  assertInput(options.workspace, "workspace", true);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), `mcres-activation-ext-${options.iteration}-`));
  try {
    const extensionRoot = prepareExtensionRoot(options.artifact, temporaryRoot);
    const workspaceRoot = path.join(temporaryRoot, "JSON 工作区 with spaces");
    copyWorkspaceWithoutActivationMarker(options.workspace, workspaceRoot);
    const codeExecutable = resolveCodeExecutable(options.codeExecutable);
    const invocation = codeInvocation(codeExecutable, [
      `--user-data-dir=${path.join(temporaryRoot, "user data")}`,
      `--extensions-dir=${path.join(temporaryRoot, "extensions")}`,
      `--extensionDevelopmentPath=${extensionRoot}`,
      `--extensionTestsPath=${extensionTestPath}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--disable-telemetry",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      workspaceRoot
    ]);
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        MCRES_ACTIVATION_ARTIFACT: options.artifact,
        MCRES_ACTIVATION_ITERATION: String(options.iteration),
        MCRES_ACTIVATION_SAMPLE_OUT: options.sampleOutput,
        MCRES_ACTIVATION_SETTLE_MS: String(options.settleMilliseconds),
        MCRES_ACTIVATION_SOURCE_WORKSPACE: options.workspace,
        MCRES_ACTIVATION_WORKSPACE: workspaceRoot,
        MCRES_ACTIVATION_EXTENSION_ROOT: extensionRoot
      }
    });
    if (result.error || result.status !== 0) {
      throw new Error([
        "Real Extension Host activation sample failed.",
        result.error?.message,
        result.stdout,
        result.stderr,
        existsSync(options.sampleOutput) ? readFileSync(options.sampleOutput, "utf8") : undefined
      ].filter(Boolean).join("\n"));
    }
    if (!existsSync(options.sampleOutput)) {
      throw new Error("Real Extension Host activation sample exited without writing its sample JSON.");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function prepareExtensionRoot(artifact, temporaryRoot) {
  if (statSync(artifact).isDirectory()) {
    assertExtensionRoot(artifact);
    return artifact;
  }
  const extractionRoot = path.join(temporaryRoot, "已安装 extension");
  mkdirSync(extractionRoot, { recursive: true });
  extractZipArchive(artifact, extractionRoot, "activation-probe VSIX");
  const extensionRoot = path.join(extractionRoot, "extension");
  assertExtensionRoot(extensionRoot);
  return extensionRoot;
}

function copyWorkspaceWithoutActivationMarker(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: candidate => path.basename(candidate).toLowerCase() !== "pack.mcmeta"
  });
}

function assertExtensionRoot(root) {
  if (!existsSync(path.join(root, "package.json"))
    || !existsSync(path.join(root, "bundle", "extension.js"))) {
    throw new Error(`Activation probe artifact is not an installed combined extension: ${root}`);
  }
}

function assertInput(fileName, label, directory = false) {
  if (!existsSync(fileName) || (directory && !statSync(fileName).isDirectory())) {
    throw new Error(`Activation probe ${label} does not exist${directory ? " as a directory" : ""}: ${fileName}`);
  }
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  runExtensionHostSample(parseExtensionHostSampleArguments(process.argv.slice(2)));
}
