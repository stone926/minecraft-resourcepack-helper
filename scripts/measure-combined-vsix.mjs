#!/usr/bin/env node

import { sha256Hex } from "./lib/hash.mjs";
import { isMainModule } from "./lib/moduleIdentity.mjs";
import { readHeadCommitTimestamp, runGitCapture } from "./lib/git.mjs";
import { writeJsonAtomically } from "./lib/json-file.mjs";
import { parseJson } from "./lib/parse.mjs";
import { assertPathAtOrBelow } from "./lib/paths.mjs";
import { defaultExecuteStep, formatStepCommand } from "./lib/steps.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  combinedVsixArtifactNames,
  createCombinedVsixReport,
  semanticJsonHash
} from "./combined-vsix-report.mjs";
import { captureCombinedVsixModeEvidence } from "./combined-vsix-evidence.mjs";
import { readBuildBudgetConfiguration } from "./build-budget-config.mjs";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

export const combinedVsixMeasurementFiles = Object.freeze({
  development: combinedVsixArtifactNames.development,
  production: combinedVsixArtifactNames.production,
  report: "combined-vsix-comparison.json"
});

export function parseCombinedVsixMeasurementArguments(args) {
  let outputDirectory = "dist/measurements";
  let hasOutputDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output-dir") {
      if (hasOutputDirectory) {
        throw new Error("--output-dir may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing path after --output-dir.");
      }
      outputDirectory = value;
      hasOutputDirectory = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      if (hasOutputDirectory) {
        throw new Error("--output-dir may only be specified once.");
      }
      outputDirectory = argument.slice("--output-dir=".length);
      if (outputDirectory.length === 0) {
        throw new Error("Missing path after --output-dir.");
      }
      hasOutputDirectory = true;
      continue;
    }
    throw new Error(`Unknown combined VSIX measurement argument: ${argument}`);
  }
  return { outputDirectory };
}

export function resolveCombinedVsixMeasurementPaths(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const measurementsRoot = path.join(repositoryRoot, "dist", "measurements");
  const outputDirectory = path.resolve(
    repositoryRoot,
    options.outputDirectory ?? "dist/measurements"
  );
  assertPathAtOrBelow(measurementsRoot, outputDirectory, "Measurement output directory");
  return Object.freeze({
    repositoryRoot,
    measurementsRoot,
    outputDirectory,
    developmentArtifact: path.join(outputDirectory, combinedVsixMeasurementFiles.development),
    productionArtifact: path.join(outputDirectory, combinedVsixMeasurementFiles.production),
    reportFile: path.join(outputDirectory, combinedVsixMeasurementFiles.report)
  });
}

export function createCombinedVsixMeasurementPlan(paths) {
  return Object.freeze([
    nodeStep("typecheck", "scripts/build.mjs", ["main", "--typecheck-only"]),
    nodeStep("development-build", "scripts/build.mjs", [
      "main", "--bundle-only", "--bundle-mode", "development"
    ]),
    nodeStep("development-stage", "scripts/assemble-main-vsix-stage.mjs", [
      "--bundle-mode", "development"
    ]),
    nodeStep("development-package", "scripts/package-vsix.mjs", [
      "main", "--out", paths.developmentArtifact
    ]),
    nodeStep("development-verify", "scripts/verify-main-vsix.mjs", [
      paths.developmentArtifact, "--comparison-development"
    ], "development"),
    nodeStep("production-build", "scripts/build.mjs", [
      "main", "--bundle-only", "--bundle-mode", "production"
    ]),
    nodeStep("production-stage", "scripts/assemble-main-vsix-stage.mjs", [
      "--bundle-mode", "production"
    ]),
    nodeStep("production-package", "scripts/package-vsix.mjs", [
      "main", "--out", paths.productionArtifact
    ]),
    nodeStep("production-verify", "scripts/verify-main-vsix.mjs", [
      paths.productionArtifact
    ], "production")
  ]);
}

export async function runCombinedVsixMeasurement(options = {}) {
  const paths = resolveCombinedVsixMeasurementPaths(options);
  const git = assertCleanGitCheckout(paths.repositoryRoot);
  const toolchain = readToolchainIdentity(paths.repositoryRoot);
  const buildBudgetConfiguration = readBuildBudgetConfiguration();
  prepareMeasurementOutputs(paths);
  const environment = { ...process.env, SOURCE_DATE_EPOCH: git.commitTimestamp };
  const evidence = {};

  for (const step of createCombinedVsixMeasurementPlan(paths)) {
    assertGitIdentityUnchanged(paths.repositoryRoot, git);
    console.log(formatStepCommand(step));
    defaultExecuteStep(step, { repositoryRoot: paths.repositoryRoot, env: environment });
    assertGitIdentityUnchanged(paths.repositoryRoot, git);
    if (step.captureMode) {
      evidence[step.captureMode] = await captureCombinedVsixModeEvidence({
        mode: step.captureMode,
        artifactFile: step.captureMode === "development"
          ? paths.developmentArtifact
          : paths.productionArtifact,
        outputDirectory: paths.outputDirectory,
        repositoryRoot: paths.repositoryRoot,
        commit: git.commit,
        toolchainFingerprint: toolchain.fingerprint,
        runtimeVerification: Object.freeze({
          script: "scripts/verify-main-vsix.mjs",
          arguments: Object.freeze(step.args.slice(1)),
          passed: true
        })
      });
    }
  }

  assertGitIdentityUnchanged(paths.repositoryRoot, git);
  const finalToolchain = readToolchainIdentity(paths.repositoryRoot);
  if (finalToolchain.fingerprint !== toolchain.fingerprint) {
    throw new Error("Build toolchain changed during combined VSIX measurement.");
  }
  const report = createCombinedVsixReport({
    repository: Object.freeze({
      commit: git.commit,
      tree: git.tree,
      commitTimestamp: git.commitTimestamp,
      clean: true
    }),
    toolchain,
    budgetConfiguration: Object.freeze({
      source: "scripts/build-budgets.json",
      schemaVersion: buildBudgetConfiguration.schemaVersion,
      mainVsix: buildBudgetConfiguration.mainVsix
    }),
    development: evidence.development,
    production: evidence.production
  });
  writeJsonAtomically(paths.reportFile, report);
  assertGitIdentityUnchanged(paths.repositoryRoot, git);
  console.log(`combined VSIX measurement report: ${paths.reportFile}`);
  console.log(`development VSIX: ${paths.developmentArtifact}`);
  console.log(`production VSIX: ${paths.productionArtifact}`);
  return Object.freeze({ paths, report });
}

function assertCleanGitCheckout(repositoryRoot) {
  const commit = runGitCapture(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  const tree = runGitCapture(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const commitTimestamp = readHeadCommitTimestamp(repositoryRoot);
  const status = runGitCapture(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new Error(
      "Combined VSIX measurement requires a clean Git checkout (tracked and untracked files)."
    );
  }
  return Object.freeze({ commit, tree, commitTimestamp });
}

function assertGitIdentityUnchanged(repositoryRoot, expected) {
  const actual = assertCleanGitCheckout(repositoryRoot);
  if (actual.commit !== expected.commit || actual.tree !== expected.tree) {
    throw new Error("Git commit/tree changed during combined VSIX measurement.");
  }
}

function readToolchainIdentity(repositoryRoot) {
  const lockBytes = readFileSync(path.join(repositoryRoot, "package-lock.json"));
  const npmInvocation = resolveNpmInvocation(["--version"]);
  const npmVersion = execFileSync(npmInvocation.file, npmInvocation.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).trim();
  const identity = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    zlib: process.versions.zlib,
    npm: npmVersion,
    typescript: readPackageVersion(repositoryRoot, "typescript"),
    esbuild: readPackageVersion(repositoryRoot, "esbuild"),
    vsce: readPackageVersion(repositoryRoot, "@vscode/vsce"),
    yauzl: readPackageVersion(repositoryRoot, "yauzl"),
    yazl: readPackageVersion(repositoryRoot, "yazl"),
    packageLockSha256: sha256Hex(lockBytes)
  };
  return Object.freeze({ ...identity, fingerprint: semanticJsonHash(identity) });
}

function readPackageVersion(repositoryRoot, packageName) {
  const segments = packageName.split("/");
  const manifest = parseJson(
    readFileSync(path.join(repositoryRoot, "node_modules", ...segments, "package.json")),
    `${packageName} package manifest`
  );
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Unable to identify ${packageName} toolchain version.`);
  }
  return manifest.version;
}

function prepareMeasurementOutputs(paths) {
  assertNoSymlinkPath(paths.repositoryRoot, paths.outputDirectory);
  mkdirSync(paths.outputDirectory, { recursive: true });
  const realRepository = realpathSync(paths.repositoryRoot);
  const realMeasurements = realpathSync(paths.measurementsRoot);
  const realOutput = realpathSync(paths.outputDirectory);
  assertPathAtOrBelow(realRepository, realMeasurements, "Real measurement root");
  assertPathAtOrBelow(realMeasurements, realOutput, "Real measurement output directory");
  for (const fileName of [paths.developmentArtifact, paths.productionArtifact, paths.reportFile]) {
    removeExactOutputFile(fileName, paths.outputDirectory);
  }
}

function removeExactOutputFile(fileName, outputDirectory) {
  assertPathAtOrBelow(outputDirectory, fileName, "Measurement output file");
  if (existsSync(fileName) && !lstatSync(fileName).isFile()) {
    throw new Error(`Measurement output path is not a regular file: ${fileName}`);
  }
  rmSync(fileName, { force: true });
}

function assertNoSymlinkPath(repositoryRoot, target) {
  const relative = path.relative(repositoryRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Measurement output path escapes the repository.");
  }
  let current = repositoryRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      continue;
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Measurement output path contains a symbolic link: ${current}`);
    }
  }
}


function nodeStep(id, script, args, captureMode) {
  return Object.freeze({ id, script, args: Object.freeze(args), captureMode });
}


if (isMainModule(import.meta.url)) {
  await runCombinedVsixMeasurement(parseCombinedVsixMeasurementArguments(process.argv.slice(2)));
}
