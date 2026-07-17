#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const budgets = JSON.parse(readFileSync(path.join(scriptDirectory, "build-budgets.json"), "utf8"));
const argumentsByName = parseArguments(process.argv.slice(2));
const verifyAll = !argumentsByName.mainVsix && !argumentsByName.rsglVsix;

if (verifyAll || argumentsByName.mainVsix) {
  verifyActivationBudget("main", "src/extension.ts");
  verifyBundle("main", "bundle/extension.js");
  verifyColdActivationBudget("main", "bundle/extension.js");
}
if (argumentsByName.mainVsix) {
  verifyVsixBudget("main", argumentsByName.mainVsix);
}

if (verifyAll || argumentsByName.rsglVsix) {
  verifyActivationBudget("rsgl", "extensions/vscode-rsgl/src/extension.ts");
  verifyBundle("rsglExtension", "extensions/vscode-rsgl/bundle/extension.js");
  verifyBundle("rsglServer", "extensions/vscode-rsgl/bundle/server.js");
  verifyBundle("rsglWorker", "extensions/vscode-rsgl/bundle/worker.js");
  verifyRsglBundleIsolation();
  verifyColdActivationBudget("rsgl", "extensions/vscode-rsgl/bundle/extension.js");
}
if (argumentsByName.rsglVsix) {
  verifyVsixBudget("rsgl", argumentsByName.rsglVsix);
}
if (verifyAll) {
  verifyBundle("rsglCli", "packages/rsgl-cli/dist/rsgl.js");
  verifyCliBundle();
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

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--main-vsix" || argument === "--rsgl-vsix") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing path after ${argument}.`);
      }
      result[argument === "--main-vsix" ? "mainVsix" : "rsglVsix"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}
