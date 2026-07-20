#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveResourceUniverseBenchmarkProfile,
  resourceUniverseBenchmarkProfiles
} from "./resource-universe-benchmark/profiles.mjs";
import {
  resourceUniverseBenchmarkLimitations,
  resourceUniverseBenchmarkScenarioIds,
  runResourceUniverseBenchmarkScenarios
} from "./resource-universe-benchmark/scenarios.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

export const defaultResourceUniverseBenchmarkOutput =
  "dist/measurements/resource-universe-benchmark.json";

export {
  resourceUniverseBenchmarkProfiles,
  resourceUniverseBenchmarkScenarioIds
};

export function parseResourceUniverseBenchmarkArguments(args) {
  let profileName = "default";
  let outputPath = defaultResourceUniverseBenchmarkOutput;
  let outputSpecified = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--smoke") {
      if (profileName === "smoke") {
        throw new Error("--smoke may only be specified once.");
      }
      profileName = "smoke";
      continue;
    }
    if (argument === "--out") {
      if (outputSpecified) {
        throw new Error("--out may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing path after --out.");
      }
      outputPath = value;
      outputSpecified = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--out=")) {
      if (outputSpecified) {
        throw new Error("--out may only be specified once.");
      }
      outputPath = argument.slice("--out=".length);
      if (outputPath.length === 0) {
        throw new Error("Missing path after --out.");
      }
      outputSpecified = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown resource-universe benchmark argument: ${argument}`);
  }
  return Object.freeze({
    profileName,
    outputPath,
    help,
    commandArguments: Object.freeze([...args])
  });
}

export function resolveResourceUniverseBenchmarkOutput(repositoryRoot, outputPath) {
  const root = path.resolve(repositoryRoot);
  const measurementsRoot = path.join(root, "dist", "measurements");
  const outputFile = path.resolve(root, outputPath ?? defaultResourceUniverseBenchmarkOutput);
  assertPathAtOrBelow(measurementsRoot, outputFile, "Resource-universe benchmark output");
  if (path.extname(outputFile).toLowerCase() !== ".json") {
    throw new Error(`Resource-universe benchmark output must be a JSON file: ${outputFile}`);
  }
  return Object.freeze({ repositoryRoot: root, measurementsRoot, outputFile });
}

export function detectResourceUniverseBenchmarkRuntime() {
  const release = os.release();
  const distroName = normalizeOptionalEnvironmentValue(process.env.WSL_DISTRO_NAME);
  const interop = normalizeOptionalEnvironmentValue(process.env.WSL_INTEROP);
  const isWslRuntime = process.platform === "linux"
    && (distroName !== null || interop !== null || /microsoft/i.test(release));
  return Object.freeze({
    kind: isWslRuntime ? "wsl" : process.platform === "win32" ? "windows" : "posix",
    isWslRuntime,
    wslDistroName: distroName,
    wslInteropPresent: interop !== null
  });
}

export async function runResourceUniverseBenchmark(options = {}) {
  const profileName = options.profileName ?? "default";
  const profile = resolveResourceUniverseBenchmarkProfile(profileName);
  const paths = resolveResourceUniverseBenchmarkOutput(
    options.repositoryRoot ?? defaultRepositoryRoot,
    options.outputPath
  );
  prepareOutput(paths);
  const processRssAtStartBytes = process.memoryUsage().rss;
  const loaded = await loadCompiledBenchmarkApi(paths.repositoryRoot);
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mcres-universe-benchmark-"));
  let scenarios;
  try {
    scenarios = await runResourceUniverseBenchmarkScenarios({
      api: loaded.api,
      fixtureRoot,
      profile
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const git = readGitIdentity(paths.repositoryRoot);
  const runtime = detectResourceUniverseBenchmarkRuntime();
  const commandArguments = options.commandArguments
    ?? (profileName === "smoke" ? ["--smoke"] : []);
  const commandArgv = [process.execPath, scriptFile, ...commandArguments];
  const report = Object.freeze({
    schemaVersion: 1,
    measurement: "resource-universe-platform-and-scale",
    status: "completed",
    generatedAt: new Date().toISOString(),
    commit: git,
    environment: Object.freeze({
      platform: process.platform,
      release: os.release(),
      version: os.version(),
      arch: process.arch,
      node: process.version,
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      processRssAtStartBytes,
      processRssAtEndBytes: process.memoryUsage().rss,
      cwd: process.cwd(),
      runtime
    }),
    command: Object.freeze({
      argv: Object.freeze(commandArgv),
      display: commandArgv.map(shellDisplayArgument).join(" "),
      profile: profileName,
      output: relativePortable(paths.repositoryRoot, paths.outputFile)
    }),
    scope: Object.freeze({
      currentPlatformFilesystem: true,
      multiRootProjectCache: true,
      syntheticVscodeRemoteUriHost: true,
      realRemoteExtensionHost: false,
      realWslRuntime: runtime.isWslRuntime,
      realWslFilesystemFixture: runtime.isWslRuntime,
      resourceUniverseLargeSnapshot: true,
      extractionFreeZipApi: true,
      profileConfiguration: profile,
      requestedScale: Object.freeze({
        multiRootProjects: profile.multiRootProjectCount,
        physicalProducers: profile.physicalProducerCount,
        physicalEdges: profile.physicalEdgeCount,
        zipEntries: profile.zipEntryCount
      })
    }),
    limitations: resourceUniverseBenchmarkLimitations,
    compiledInputs: loaded.inputs,
    scenarios
  });
  writeJsonAtomically(paths.outputFile, report);
  return Object.freeze({ paths, report });
}

async function loadCompiledBenchmarkApi(repositoryRoot) {
  const modulePaths = Object.freeze({
    resourceProjectCore: path.join(repositoryRoot, "out", "packages", "resource-project", "src", "index.js"),
    resourceProjectNode: path.join(repositoryRoot, "out", "packages", "resource-project", "src", "node.js"),
    projectService: path.join(repositoryRoot, "out", "src", "resourceProject", "resourcePackProjectService.js"),
    universeIndex: path.join(repositoryRoot, "out", "src", "resourceUniverse", "core", "resourceUniverseIndex.js"),
    zipArchive: path.join(repositoryRoot, "out", "src", "resourceUniverse", "virtualFs", "zipArchive.js")
  });
  for (const fileName of Object.values(modulePaths)) {
    if (!existsSync(fileName)) {
      throw new Error(
        `Missing compiled pure benchmark input at ${fileName}. Run npm run build -- --typecheck-only first.`
      );
    }
  }
  const [resourceProjectCore, resourceProjectNode, projectService, universeIndex, zipArchive] =
    await Promise.all(Object.values(modulePaths).map(importCommonJsModule));
  const api = Object.freeze({
    normalizeResourceProjectUri: requireFunction(resourceProjectCore, "normalizeResourceProjectUri"),
    resolveResourceProjectUri: requireFunction(resourceProjectCore, "resolveResourceProjectUri"),
    resourceProjectUriIdentity: requireFunction(resourceProjectCore, "resourceProjectUriIdentity"),
    resourceProjectUriParent: requireFunction(resourceProjectCore, "resourceProjectUriParent"),
    nodePathToResourceProjectUri: requireFunction(resourceProjectNode, "nodePathToResourceProjectUri"),
    resourceProjectUriToNodePath: requireFunction(resourceProjectNode, "resourceProjectUriToNodePath"),
    ResourcePackProjectService: requireFunction(projectService, "ResourcePackProjectService"),
    ResourceUniverseIndex: requireFunction(universeIndex, "ResourceUniverseIndex"),
    ZipArchive: requireFunction(zipArchive, "ZipArchive")
  });
  const inputs = Object.freeze(Object.fromEntries(Object.entries(modulePaths).map(([name, fileName]) => [
    name,
    Object.freeze({
      path: relativePortable(repositoryRoot, fileName),
      bytes: lstatSync(fileName).size,
      sha256: sha256(readFileSync(fileName))
    })
  ])));
  return Object.freeze({ api, inputs });
}

async function importCommonJsModule(fileName) {
  const namespace = await import(pathToFileURL(fileName).href);
  return namespace.default && typeof namespace.default === "object"
    ? { ...namespace.default, ...namespace }
    : namespace;
}

function requireFunction(moduleValue, name) {
  const value = moduleValue[name];
  if (typeof value !== "function") {
    throw new Error(`Compiled benchmark input is missing '${name}'.`);
  }
  return value;
}

function readGitIdentity(repositoryRoot) {
  try {
    const sha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    const status = runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return Object.freeze({ sha, dirty: status.length > 0 });
  } catch {
    return Object.freeze({ sha: null, dirty: null });
  }
}

function runGit(repositoryRoot, args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`, ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }
  ).trim();
}

function prepareOutput(paths) {
  mkdirSync(paths.measurementsRoot, { recursive: true });
  mkdirSync(path.dirname(paths.outputFile), { recursive: true });
  removeExactRegularFile(paths.outputFile);
  removeExactRegularFile(`${paths.outputFile}.tmp`);
}

function removeExactRegularFile(fileName) {
  if (!existsSync(fileName)) {
    return;
  }
  if (!lstatSync(fileName).isFile()) {
    throw new Error(`Benchmark output path is not a regular file: ${fileName}`);
  }
  rmSync(fileName, { force: true });
}

function writeJsonAtomically(fileName, value) {
  const temporary = `${fileName}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, fileName);
}

function assertPathAtOrBelow(parent, candidate, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative !== "" && (relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative))) {
    throw new Error(`${label} must stay inside ${parent}: ${candidate}`);
  }
}

function relativePortable(root, fileName) {
  return path.relative(root, fileName).replaceAll("\\", "/");
}

function shellDisplayArgument(argument) {
  return /^[A-Za-z0-9_./:@=+\\-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeOptionalEnvironmentValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function printUsage() {
  console.log([
    "Usage: node scripts/resource-universe-benchmark.mjs [--smoke] [--out path]",
    "",
    `Default output: ${defaultResourceUniverseBenchmarkOutput}`,
    "The vscode-remote row uses a synthetic URI-only host and never claims a real remote run."
  ].join("\n"));
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
  try {
    const options = parseResourceUniverseBenchmarkArguments(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      const result = await runResourceUniverseBenchmark(options);
      console.log(`Resource-universe benchmark report: ${result.paths.outputFile}`);
      console.log(`Profile: ${result.report.command.profile}`);
      console.log(result.report.scope.realWslRuntime
        ? "Platform scope: real WSL Node runtime and /tmp filesystem fixture."
        : `Platform scope: real ${result.report.environment.platform} Node runtime and filesystem fixture.`);
      console.log("Remote-host scope: synthetic URI-only host; real Remote Extension Host evidence remains external.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
