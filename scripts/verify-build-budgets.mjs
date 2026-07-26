#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { bundleEntryDefinitions, bundleModes } from "./build-bundles.mjs";
import {
  mainVsixBudgetEntryIds,
  readBuildBudgetConfiguration
} from "./build-budget-config.mjs";
import { findVsixArchiveEntry, readVsixArchiveMetrics } from "./vsix-archive-metrics.mjs";

export {
  mainVsixBudgetEntryIds,
  parseBuildBudgetConfiguration,
  readBuildBudgetConfiguration
} from "./build-budget-config.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const supportedTargets = Object.freeze(["main", "rsgl-cli"]);
const targetEntries = Object.freeze({
  main: mainVsixBudgetEntryIds,
  "rsgl-cli": Object.freeze(["cli"])
});
const budgets = readBuildBudgetConfiguration();

export function parseBudgetArguments(args) {
  let target = "all";
  let artifactPath;
  let bundleMode = "development";
  let hasTarget = false;
  let hasArtifact = false;
  let hasBundleMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--target") {
      if (hasTarget) {
        throw new Error("--target may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing target after --target.");
      }
      target = value;
      hasTarget = true;
      index += 1;
      continue;
    }
    if (argument === "--artifact") {
      if (hasArtifact) {
        throw new Error("--artifact may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing path after --artifact.");
      }
      artifactPath = value;
      hasArtifact = true;
      index += 1;
      continue;
    }
    if (argument === "--bundle-mode") {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --bundle-mode.");
      }
      bundleMode = value;
      hasBundleMode = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--bundle-mode=")) {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      bundleMode = argument.slice("--bundle-mode=".length);
      hasBundleMode = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  budgetTargets(target);
  assertBundleMode(bundleMode);
  if (artifactPath && target !== "main") {
    throw new Error("--artifact requires --target main.");
  }
  return { target, artifactPath, bundleMode };
}

export function budgetTargets(target) {
  if (target === "all") {
    return [...supportedTargets];
  }
  if (!supportedTargets.includes(target)) {
    throw new Error(
      `Unknown budget target '${target}'. Expected all, ${supportedTargets.join(", ")}.`
    );
  }
  return [target];
}

export function createBudgetPlan(options = {}) {
  const target = options.target ?? "all";
  const artifactPath = options.artifactPath;
  const bundleMode = options.bundleMode ?? "development";
  const targets = budgetTargets(target);
  assertBundleMode(bundleMode);
  if (artifactPath !== undefined
    && (typeof artifactPath !== "string" || artifactPath.length === 0)) {
    throw new Error("An artifact path must be a non-empty string.");
  }
  if (artifactPath !== undefined && target !== "main") {
    throw new Error("An artifact path requires the main budget target.");
  }
  return targets.map(selectedTarget => Object.freeze({
    target: selectedTarget,
    artifactPath: selectedTarget === target ? artifactPath : undefined,
    bundleMode
  }));
}

export async function verifyBuildBudgets(options = {}) {
  const verifiedEntries = new Set();
  for (const step of createBudgetPlan(options)) {
    for (const entryId of targetEntries[step.target]) {
      if (verifiedEntries.has(entryId)) {
        continue;
      }
      verifyBundle(entryId, step.bundleMode);
      verifiedEntries.add(entryId);
    }
    if (step.target === "main") {
      verifyActivationBudget("root", "src/extension.ts");
      verifyColdActivationBudget("root", bundleEntryDefinitions.root.outfile);
      verifyActivationBudget("rsglHost", "src/rsgl/host/rsglHost.ts");
      verifyColdActivationBudget("rsglHost", bundleEntryDefinitions.rsglHost.outfile);
      verifyRsglBundleIsolation(true);
    } else if (step.target === "rsgl-cli") {
      verifyCliBundle();
    }
    if (step.artifactPath !== undefined) {
      await verifyVsixBudget(step.target, step.artifactPath);
    }
  }
}

function verifyActivationBudget(name, entryPoint) {
  const modules = collectStaticModules(path.join(repositoryRoot, entryPoint));
  const maximum = budgets.activationModules[name];
  assertWithinBudget(`${name} activation modules`, modules.size, maximum);
}

function collectStaticModules(entryPoint) {
  const visited = new Set();
  const visit = fileName => {
    const normalizedFileName = path.normalize(fileName);
    if (visited.has(normalizedFileName)) {
      return;
    }
    visited.add(normalizedFileName);
    const source = readFileSync(normalizedFileName, "utf8");
    for (const specifier of staticModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveTypeScriptModule(path.dirname(normalizedFileName), specifier);
      if (resolved) {
        visit(resolved);
      }
    }
  };
  visit(entryPoint);
  return visited;
}

function staticModuleSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import\s+(?!type\b)(?:[^"'()]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveTypeScriptModule(directory, specifier) {
  const candidate = path.resolve(directory, specifier);
  for (const fileName of [
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, "index.ts"),
    path.join(candidate, "index.tsx")
  ]) {
    if (existsSync(fileName)) {
      return fileName;
    }
  }
  return null;
}

function verifyBundle(entryId, bundleMode) {
  const definition = bundleEntryDefinitions[entryId];
  const fileName = path.join(repositoryRoot, definition.outfile);
  const sourceMap = `${fileName}.map`;
  if (!existsSync(fileName) || !existsSync(sourceMap)) {
    throw new Error(`${entryId} ${bundleMode} bundle or source map is missing: ${definition.outfile}`);
  }
  const budgetMode = bundleMode === "development" ? "development" : "production";
  assertWithinBudget(
    `${entryId} ${bundleMode} bundle bytes`,
    statSync(fileName).size,
    budgets.bundleBytes[budgetMode]?.[entryId]
  );
  const gzipMaximum = budgets.bundleGzipBytes?.[budgetMode]?.[entryId];
  if (gzipMaximum !== undefined) {
    assertWithinBudget(
      `${entryId} ${bundleMode} gzip bytes`,
      gzipSync(readFileSync(fileName)).length,
      gzipMaximum
    );
  }
}

function verifyRsglBundleIsolation(includeRoot) {
  const rsglHost = readFileSync(path.join(repositoryRoot, bundleEntryDefinitions.rsglHost.outfile), "utf8");
  const sources = [["rsglHost", rsglHost]];
  if (includeRoot) {
    sources.unshift([
      "root",
      readFileSync(path.join(repositoryRoot, bundleEntryDefinitions.root.outfile), "utf8")
    ]);
  }
  for (const [name, source] of sources) {
    if (source.includes("parentPort.once")) {
      throw new Error(`RSGL worker code was folded into the ${name} extension-host bundle.`);
    }
    if (source.includes("createConnection(ProposedFeatures")) {
      throw new Error(`RSGL language server code was folded into the ${name} extension-host bundle.`);
    }
  }
}

function verifyCliBundle() {
  const cli = readFileSync(path.join(repositoryRoot, bundleEntryDefinitions.cli.outfile), "utf8");
  if (!cli.startsWith("#!/usr/bin/env node")) {
    throw new Error("RSGL CLI bundle is missing its executable shebang.");
  }
}

function verifyColdActivationBudget(name, relativeFileName) {
  const result = spawnSync(process.execPath, [
    path.join(scriptDirectory, "measure-cold-activation.mjs"),
    path.join(repositoryRoot, relativeFileName)
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Unable to measure ${name} cold activation.`,
      result.error?.message,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  const measurement = JSON.parse(result.stdout);
  assertWithinBudget(
    `${name} cold activation milliseconds`,
    Math.ceil(measurement.milliseconds),
    budgets.coldActivationMilliseconds[name]
  );
}

async function verifyVsixBudget(name, relativeFileName) {
  const absoluteFileName = path.resolve(repositoryRoot, relativeFileName);
  if (!existsSync(absoluteFileName)) {
    throw new Error(`${name} VSIX does not exist: ${absoluteFileName}`);
  }
  const metrics = await readVsixArchiveMetrics(absoluteFileName);
  for (const metric of ["archiveBytes", "compressedEntriesBytes", "installedBytes", "fileCount"]) {
    assertFrozenArtifactBudget(
      `${name} VSIX ${metric}`,
      metrics[metric],
      budgets.mainVsix[metric]
    );
  }
  for (const entryId of mainVsixBudgetEntryIds) {
    const archivePath = `extension/${bundleEntryDefinitions[entryId].outfile}`;
    const entry = findVsixArchiveEntry(metrics, archivePath);
    if (!entry || entry.directory) {
      throw new Error(`${name} VSIX is missing budgeted runtime entry: ${archivePath}`);
    }
    assertFrozenArtifactBudget(
      `${name} VSIX ${entryId} compressed bytes`,
      entry.compressedBytes,
      budgets.mainVsix.runtimeEntryCompressedBytes[entryId]
    );
  }
}

function assertBundleMode(bundleMode) {
  if (!bundleModes.includes(bundleMode)) {
    throw new Error(`Unknown bundle mode '${bundleMode}'. Expected ${bundleModes.join(", ")}.`);
  }
}

function assertWithinBudget(label, actual, maximum) {
  if (!Number.isFinite(maximum)) {
    throw new Error(`Missing numeric budget for ${label}.`);
  }
  if (actual > maximum) {
    throw new Error(`${label} exceeded its budget: ${actual} > ${maximum}.`);
  }
  console.log(`${label}: ${actual}/${maximum}`);
}

function assertFrozenArtifactBudget(label, actual, maximum) {
  if (maximum === null) {
    throw new Error(
      `Budget for ${label} is not frozen. Run npm run measure:combined-vsix and review its budgetCandidate.`
    );
  }
  assertWithinBudget(label, actual, maximum);
}


if (isMainModule(import.meta.url)) {
  await verifyBuildBudgets(parseBudgetArguments(process.argv.slice(2)));
}
