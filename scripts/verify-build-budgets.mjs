#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const budgets = JSON.parse(readFileSync(path.join(scriptDirectory, "build-budgets.json"), "utf8"));

const supportedTargets = Object.freeze(["main", "rsgl", "rsgl-cli"]);

export function parseBudgetArguments(args) {
  let target = "all";
  let artifactPath;
  let hasTarget = false;
  let hasArtifact = false;

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
    throw new Error(`Unknown argument: ${argument}`);
  }

  budgetTargets(target);
  if (artifactPath && target !== "main" && target !== "rsgl") {
    throw new Error("--artifact requires --target main or --target rsgl.");
  }
  return { target, artifactPath };
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
  const targets = budgetTargets(target);
  if (artifactPath !== undefined
    && (typeof artifactPath !== "string" || artifactPath.length === 0)) {
    throw new Error("An artifact path must be a non-empty string.");
  }
  if (artifactPath !== undefined && target !== "main" && target !== "rsgl") {
    throw new Error("An artifact path requires the main or rsgl budget target.");
  }
  return targets.map(selectedTarget => Object.freeze({
    target: selectedTarget,
    artifactPath: selectedTarget === target ? artifactPath : undefined
  }));
}

export function verifyBuildBudgets(options = {}) {
  for (const step of createBudgetPlan(options)) {
    if (step.target === "main") {
      verifyActivationBudget("main", "src/extension.ts");
      verifyBundle("main", "bundle/extension.js");
      verifyColdActivationBudget("main", "bundle/extension.js");
      if (step.artifactPath !== undefined) {
        verifyVsixBudget("main", step.artifactPath);
      }
      continue;
    }
    if (step.target === "rsgl") {
      verifyActivationBudget("rsgl", "extensions/vscode-rsgl/src/extension.ts");
      verifyBundle("rsglExtension", "extensions/vscode-rsgl/bundle/extension.js");
      verifyBundle("rsglServer", "extensions/vscode-rsgl/bundle/server.js");
      verifyBundle("rsglWorker", "extensions/vscode-rsgl/bundle/worker.js");
      verifyRsglBundleIsolation();
      verifyColdActivationBudget("rsgl", "extensions/vscode-rsgl/bundle/extension.js");
      if (step.artifactPath !== undefined) {
        verifyVsixBudget("rsgl", step.artifactPath);
      }
      continue;
    }
    if (step.target === "rsgl-cli") {
      verifyBundle("rsglCli", "packages/rsgl-cli/dist/rsgl.js");
      verifyCliBundle();
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

function verifyBundle(name, relativeFileName) {
  const fileName = path.join(repositoryRoot, relativeFileName);
  const sourceMap = `${fileName}.map`;
  if (!existsSync(fileName) || !existsSync(sourceMap)) {
    throw new Error(`${name} bundle or source map is missing: ${relativeFileName}`);
  }
  assertWithinBudget(`${name} bundle bytes`, statSync(fileName).size, budgets.bundleBytes[name]);
}

function verifyRsglBundleIsolation() {
  const rsglExtension = readFileSync(
    path.join(repositoryRoot, "extensions/vscode-rsgl/bundle/extension.js"),
    "utf8"
  );
  if (rsglExtension.includes("parentPort.once")) {
    throw new Error("RSGL worker code was folded into the extension-host bundle.");
  }
  if (rsglExtension.includes("createConnection(ProposedFeatures")) {
    throw new Error("RSGL language server code was folded into the extension-host bundle.");
  }
}

function verifyCliBundle() {
  const cli = readFileSync(path.join(repositoryRoot, "packages/rsgl-cli/dist/rsgl.js"), "utf8");
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

function verifyVsixBudget(name, relativeFileName) {
  const absoluteFileName = path.resolve(repositoryRoot, relativeFileName);
  if (!existsSync(absoluteFileName)) {
    throw new Error(`${name} VSIX does not exist: ${absoluteFileName}`);
  }
  const entries = listArchiveEntries(absoluteFileName);
  assertWithinBudget(`${name} VSIX files`, entries.filter(Boolean).length, budgets.vsixFiles[name]);
}

function listArchiveEntries(fileName) {
  const command = process.platform === "win32"
    ? { file: "tar", args: ["-tf", fileName] }
    : { file: "unzip", args: ["-Z1", fileName] };
  const result = spawnSync(command.file, command.args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Unable to list ${fileName} with ${command.file}.`,
      result.error?.message,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim().split(/\r?\n/);
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
  verifyBuildBudgets(parseBudgetArguments(process.argv.slice(2)));
}
