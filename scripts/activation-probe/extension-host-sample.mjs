#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  codeInvocation,
  resolveCodeExecutable
} from "../extension-host-harness.mjs";
import {
  isActivationProbeIdentifier,
  validateActivationProbeSample
} from "./schema.mjs";

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
  const required = [
    "--artifact",
    "--extension-root",
    "--workspace",
    "--iteration",
    "--settle-ms",
    "--sample-out",
    "--probe-run-id",
    "--sample-id",
    "--artifact-sha256",
    "--artifact-bytes"
  ];
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
  const probeRunId = values.get("--probe-run-id");
  const sampleId = values.get("--sample-id");
  if (!isActivationProbeIdentifier(probeRunId)
    || !isActivationProbeIdentifier(sampleId)) {
    throw new Error("--probe-run-id and --sample-id must be 32-character lowercase hexadecimal challenges.");
  }
  return {
    artifact: path.resolve(values.get("--artifact")),
    extensionRoot: path.resolve(values.get("--extension-root")),
    workspace: path.resolve(values.get("--workspace")),
    probeRunId,
    sampleId,
    artifactIdentity: {
      sha256: parseSha256(values.get("--artifact-sha256"), "--artifact-sha256"),
      bytes: parseInteger(values.get("--artifact-bytes"), "--artifact-bytes", 1, Number.MAX_SAFE_INTEGER)
    },
    iteration: parseInteger(values.get("--iteration"), "--iteration", 0, 10_000),
    settleMilliseconds: parseInteger(values.get("--settle-ms"), "--settle-ms", 0, 10_000),
    sampleOutput: path.resolve(values.get("--sample-out")),
    codeExecutable: values.has("--code") ? path.resolve(values.get("--code")) : undefined
  };
}

export function runExtensionHostSample(options) {
  assertInput(options.artifact, "artifact");
  assertInput(options.extensionRoot, "extension root", true);
  assertExtensionRoot(options.extensionRoot);
  assertInput(options.workspace, "workspace", true);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), `mcres-activation-ext-${options.iteration}-`));
  try {
    const extensionRoot = canonicalPath(options.extensionRoot);
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
        MCRES_ACTIVATION_PROBE_RUN_ID: options.probeRunId,
        MCRES_ACTIVATION_SAMPLE_ID: options.sampleId,
        MCRES_ACTIVATION_ARTIFACT_SHA256: options.artifactIdentity.sha256,
        MCRES_ACTIVATION_ARTIFACT_BYTES: String(options.artifactIdentity.bytes),
        MCRES_ACTIVATION_SAMPLE_OUT: options.sampleOutput,
        MCRES_ACTIVATION_SETTLE_MS: String(options.settleMilliseconds),
        MCRES_ACTIVATION_SOURCE_WORKSPACE: options.workspace,
        MCRES_ACTIVATION_WORKSPACE: workspaceRoot,
        MCRES_ACTIVATION_EXTENSION_ROOT: extensionRoot
      }
    });
    if (!existsSync(options.sampleOutput)) {
      throw new Error([
        "Real Extension Host activation sample exited without writing its sample JSON.",
        result.error?.message,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n"));
    }
    const sample = readExtensionHostSample(options.sampleOutput);
    assertSampleIdentity(sample, options, extensionRoot);
    assertExitMatchesSample(result, sample, "VS Code Extension Host test process");
    if (sample.status === "error") {
      throw new Error([
        "Real Extension Host activation sample reported an error.",
        sample.error?.message,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n"));
    }
    return sample;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function readExtensionHostSample(sampleOutput) {
  try {
    return validateActivationProbeSample(
      JSON.parse(readFileSync(sampleOutput, "utf8")),
      "extension-host"
    );
  } catch (error) {
    throw new Error("Real Extension Host activation sample JSON is invalid.", { cause: error });
  }
}

function assertSampleIdentity(sample, options, extensionRoot) {
  if (sample.probeRunId !== options.probeRunId
    || sample.sampleId !== options.sampleId
    || sample.iteration !== options.iteration
    || sample.artifact.sha256 !== options.artifactIdentity.sha256
    || sample.artifact.bytes !== options.artifactIdentity.bytes
    || !samePath(sample.activatedExtensionRoot, canonicalPath(extensionRoot))) {
    throw new Error("Real Extension Host activation sample did not echo its challenges, iteration, and artifact identity.");
  }
}

function assertExitMatchesSample(result, sample, label) {
  if (result.error) {
    throw new Error(`${label} failed before its exit status could be trusted.`, { cause: result.error });
  }
  const exitMatches = sample.status === "ok"
    ? result.status === 0
    : Number.isSafeInteger(result.status) && result.status !== 0;
  if (!exitMatches) {
    throw new Error(
      `${label} exit status ${String(result.status)} is inconsistent with sample status '${sample.status}'.`
    );
  }
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

function canonicalPath(value) {
  return realpathSync.native(path.resolve(value));
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function parseSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  runExtensionHostSample(parseExtensionHostSampleArguments(process.argv.slice(2)));
}
