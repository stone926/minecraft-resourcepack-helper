#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { isMainModule } from "./lib/moduleIdentity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const runtimeCacheDirectoryName = "minecraft-resourcepack-helper-vscode-test";

/** Downloads the extension's minimum supported VS Code and exposes it to later Actions steps. */
export async function prepareVscodeTestRuntime(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const environment = options.environment ?? process.env;
  const githubEnvironmentFile = requireGitHubEnvironmentFile(environment.GITHUB_ENV);
  const manifest = readManifest(path.join(repositoryRoot, "package.json"));
  const version = minimumVscodeEngineVersion(manifest.engines?.vscode);
  const temporaryRoot = environment.RUNNER_TEMP || options.temporaryDirectory || tmpdir();
  const cachePath = path.join(path.resolve(temporaryRoot), runtimeCacheDirectoryName);
  const downloadRuntime = options.downloadRuntime ?? downloadAndUnzipVSCode;

  mkdirSync(cachePath, { recursive: true });
  const executablePath = path.resolve(await downloadRuntime({ version, cachePath }));
  if (!statSync(executablePath).isFile()) {
    throw new Error(`Downloaded VS Code executable is not a file: ${executablePath}`);
  }
  appendGitHubEnvironmentVariable(
    githubEnvironmentFile,
    "VSCODE_EXECUTABLE_PATH",
    executablePath
  );

  console.log(`Prepared VS Code ${version} at ${executablePath}`);
  return { version, cachePath, executablePath };
}

/** Resolves the exact lower bound from the root extension's canonical caret engine range. */
export function minimumVscodeEngineVersion(range) {
  if (typeof range !== "string") {
    throw new Error("package.json engines.vscode must be a caret range with an exact version.");
  }
  const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(range.trim());
  if (!match) {
    throw new Error(
      `package.json engines.vscode must be a caret range with an exact version; received ${range}.`
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Writes one injection-safe, single-line GitHub Actions environment record without a shell. */
export function appendGitHubEnvironmentVariable(fileName, name, value) {
  if (!path.isAbsolute(fileName)) {
    throw new Error("GITHUB_ENV must be an absolute path.");
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid GitHub Actions environment variable name: ${name}`);
  }
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a single-line value without NUL bytes.`);
  }
  appendFileSync(fileName, `${name}=${value}\n`, "utf8");
}

function requireGitHubEnvironmentFile(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("GITHUB_ENV is required to expose the VS Code test runtime.");
  }
  return path.resolve(value);
}

function readManifest(fileName) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(fileName, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read root extension manifest ${fileName}.`, { cause: error });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Root extension manifest must contain a JSON object: ${fileName}`);
  }
  return manifest;
}

if (isMainModule(import.meta.url)) {
  await prepareVscodeTestRuntime();
}
