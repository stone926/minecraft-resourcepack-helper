#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bundleEntriesCjs from "./lib/bundleEntries.cjs";

const { bundleEntryOutfiles } = bundleEntriesCjs;

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, "..");
const stdlibSource = path.join(repositoryRoot, "packages", "rsgl-core", "src", "stdlib", "rsgl");
const threeLicenseSource = path.join(repositoryRoot, "node_modules", "three", "LICENSE");
const threeLicenseTarget = path.join(repositoryRoot, "licenses", "THREE-LICENSE.txt");
const singletonExternalNamespace = "singleton-external";

export const bundleModes = Object.freeze(["development", "production", "analyze"]);
export const bundleAnalysisOutputs = Object.freeze({
  directory: "dist/build-analysis",
  duplicateReport: "dist/build-analysis/duplicate-modules.json"
});
const analysisRoot = path.join(repositoryRoot, bundleAnalysisOutputs.directory);

export const bundleEntryDefinitions = Object.freeze({
  root: entry({
    entryPoint: "src/extension.ts",
    outfile: bundleEntryOutfiles.root,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    singletonExternals: ["vscode"]
  }),
  rsglHost: entry({
    entryPoint: "src/rsgl/host/rsglHost.ts",
    outfile: bundleEntryOutfiles.rsglHost,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    singletonExternals: ["vscode"]
  }),
  server: entry({
    entryPoint: "packages/rsgl-lsp/src/server.ts",
    outfile: bundleEntryOutfiles.server,
    platform: "node",
    format: "cjs",
    target: "node22"
  }),
  worker: entry({
    entryPoint: "src/rsgl/host/commands/buildWorker.ts",
    outfile: bundleEntryOutfiles.worker,
    platform: "node",
    format: "cjs",
    target: "node22"
  }),
  modelPreview: entry({
    entryPoint: "webviews/modelPreview/main.js",
    outfile: bundleEntryOutfiles.modelPreview,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: []
  }),
  cli: entry({
    entryPoint: "packages/rsgl-cli/src/main.ts",
    outfile: bundleEntryOutfiles.cli,
    platform: "node",
    format: "cjs",
    target: "node20",
    banner: "#!/usr/bin/env node"
  })
});

export const bundleTargetProfiles = Object.freeze({
  main: Object.freeze(["root", "rsglHost", "server", "worker", "modelPreview"]),
  // Transitional focused target; the distributable paths still belong to the single main VSIX.
  rsgl: Object.freeze(["rsglHost", "server", "worker"]),
  "rsgl-cli": Object.freeze(["cli"]),
  all: Object.freeze(["root", "rsglHost", "server", "worker", "modelPreview", "cli"])
});

export function parseBundleArguments(args) {
  let targetName = "all";
  let bundleMode = "development";
  let hasTarget = false;
  let hasBundleMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
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
    if (argument.startsWith("--")) {
      throw new Error(`Unknown bundle flag: ${argument}`);
    }
    if (hasTarget) {
      throw new Error(`Unexpected bundle target: ${argument}`);
    }
    targetName = argument;
    hasTarget = true;
  }

  assertBundleTarget(targetName);
  assertBundleMode(bundleMode);
  return { targetName, bundleMode };
}

export function createBundlePlan(targetName = "all", bundleMode = "development") {
  assertBundleTarget(targetName);
  assertBundleMode(bundleMode);
  return Object.freeze(bundleTargetProfiles[targetName].map(id => Object.freeze({
    id,
    bundleMode,
    definition: bundleEntryDefinitions[id]
  })));
}

export function createEsbuildOptions(definition, bundleMode, overrides = {}) {
  assertBundleMode(bundleMode);
  const optimized = bundleMode !== "development";
  return {
    absWorkingDir: repositoryRoot,
    entryPoints: [definition.entryPoint],
    outfile: path.join(repositoryRoot, definition.outfile),
    bundle: true,
    platform: definition.platform,
    format: definition.format,
    target: definition.target,
    sourcemap: "external",
    sourcesContent: false,
    treeShaking: true,
    minify: optimized,
    define: {
      "process.env.NODE_ENV": JSON.stringify(optimized ? "production" : "development")
    },
    charset: "utf8",
    legalComments: "none",
    logLevel: "warning",
    external: [...definition.external],
    plugins: createSingletonExternalPlugins(definition),
    banner: definition.banner ? { js: definition.banner } : undefined,
    metafile: bundleMode === "analyze",
    ...overrides
  };
}

export async function buildBundleTarget({ targetName = "all", bundleMode = "development" } = {}) {
  const plan = createBundlePlan(targetName, bundleMode);
  cleanPlanOutputs(plan);
  if (bundleMode === "analyze") {
    rmSync(analysisRoot, { recursive: true, force: true });
  }

  const results = [];
  for (const item of plan) {
    const outfile = path.join(repositoryRoot, item.definition.outfile);
    mkdirSync(path.dirname(outfile), { recursive: true });
    const result = await build(createEsbuildOptions(item.definition, bundleMode));
    results.push({ ...item, result });
  }

  copyRuntimeAssets(plan);
  if (bundleMode === "analyze") {
    writeAnalysisReports(results);
  }
  return results;
}

function entry(definition) {
  return Object.freeze({
    ...definition,
    external: Object.freeze([...(definition.external ?? [])]),
    singletonExternals: Object.freeze([...(definition.singletonExternals ?? [])])
  });
}

/**
 * Node caches external CommonJS modules by resolved identity, but esbuild emits
 * one require call per source importer. Route selected static imports through
 * one bundled module so cold activation performs the observable load once.
 * Dynamic imports deliberately stay untouched because they define lazy feature
 * boundaries such as the installed RSGL host URL loader.
 */
function createSingletonExternalPlugins(definition) {
  const specifiers = new Set(definition.singletonExternals ?? []);
  if (specifiers.size === 0) {
    return [];
  }
  if (definition.platform !== "node" || definition.format !== "cjs") {
    throw new Error("Singleton externals require a Node CommonJS bundle entry.");
  }
  for (const specifier of specifiers) {
    if (!definition.external.includes(specifier)) {
      throw new Error(`Singleton external '${specifier}' must also be declared external.`);
    }
  }

  return [{
    name: singletonExternalNamespace,
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, args => {
        if (!specifiers.has(args.path)) {
          return undefined;
        }
        if (args.namespace === singletonExternalNamespace) {
          return { path: args.path, external: true };
        }
        if (args.kind !== "import-statement") {
          return undefined;
        }
        return { path: args.path, namespace: singletonExternalNamespace };
      });
      buildContext.onLoad(
        { filter: /.*/, namespace: singletonExternalNamespace },
        args => ({
          contents: `"use strict";\nmodule.exports = require(${JSON.stringify(args.path)});\n`,
          loader: "js"
        })
      );
    }
  }];
}

function assertBundleTarget(targetName) {
  if (!Object.hasOwn(bundleTargetProfiles, targetName)) {
    throw new Error(
      `Unknown bundle target '${targetName}'. Expected ${Object.keys(bundleTargetProfiles).join(", ")}.`
    );
  }
}

function assertBundleMode(bundleMode) {
  if (!bundleModes.includes(bundleMode)) {
    throw new Error(`Unknown bundle mode '${bundleMode}'. Expected ${bundleModes.join(", ")}.`);
  }
}

function cleanPlanOutputs(plan) {
  for (const item of plan) {
    const outfile = path.join(repositoryRoot, item.definition.outfile);
    rmSync(outfile, { force: true });
    rmSync(`${outfile}.map`, { force: true });
  }
  if (plan.some(item => item.id === "server" || item.id === "worker" || item.id === "rsglHost")) {
    rmSync(path.join(repositoryRoot, "bundle", "rsgl", "stdlib"), { recursive: true, force: true });
  }
  if (plan.some(item => item.id === "cli")) {
    rmSync(path.join(repositoryRoot, "packages", "rsgl-cli", "dist", "rsgl"), { recursive: true, force: true });
  }
}

export function copyRuntimeAssets(plan) {
  if (plan.some(item => item.id === "server" || item.id === "worker" || item.id === "rsglHost")) {
    copyDirectoryOrCreate(stdlibSource, path.join(repositoryRoot, "bundle", "rsgl", "stdlib"));
  }
  if (plan.some(item => item.id === "cli")) {
    copyDirectoryOrCreate(stdlibSource, path.join(repositoryRoot, "packages", "rsgl-cli", "dist", "rsgl"));
  }
  if (plan.some(item => item.id === "modelPreview")) {
    if (!existsSync(threeLicenseSource)) {
      throw new Error(`Three.js license is missing: ${threeLicenseSource}`);
    }
    mkdirSync(path.dirname(threeLicenseTarget), { recursive: true });
    cpSync(threeLicenseSource, threeLicenseTarget);
  }
}

function copyDirectoryOrCreate(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(source)) {
    cpSync(source, target, { recursive: true });
  } else {
    mkdirSync(target, { recursive: true });
  }
}

function writeAnalysisReports(results) {
  mkdirSync(analysisRoot, { recursive: true });
  const occurrences = new Map();
  const entries = [];

  for (const { id, definition, result } of results) {
    const metafile = result.metafile;
    if (!metafile) {
      throw new Error(`Analyze build did not return a metafile for ${id}.`);
    }
    writeJson(path.join(analysisRoot, `${id}.metafile.json`), metafile);
    entries.push({
      id,
      entryPoint: definition.entryPoint,
      outfile: definition.outfile,
      bytes: statSync(path.join(repositoryRoot, definition.outfile)).size
    });
    for (const [input, details] of Object.entries(metafile.inputs)) {
      const inputPath = canonicalInputPath(input);
      const occurrence = occurrences.get(inputPath) ?? { entries: new Set(), sourceBytes: 0 };
      occurrence.entries.add(id);
      occurrence.sourceBytes = Math.max(occurrence.sourceBytes, details.bytes ?? 0);
      occurrences.set(inputPath, occurrence);
    }
  }

  const duplicates = [...occurrences.entries()]
    .filter(([, value]) => value.entries.size > 1)
    .map(([input, value]) => ({
      input,
      entries: [...value.entries].sort(),
      sourceBytes: value.sourceBytes
    }))
    .sort((left, right) => left.input.localeCompare(right.input, "en"));
  const threeInputs = [...occurrences.keys()]
    .filter(input => input.includes("/node_modules/three/"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const threeManifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, "node_modules", "three", "package.json"),
    "utf8"
  ));

  writeJson(path.join(analysisRoot, "duplicate-modules.json"), {
    schemaVersion: 1,
    bundleMode: "analyze",
    entries: entries.sort((left, right) => left.id.localeCompare(right.id, "en")),
    duplicates,
    three: {
      packageRealpath: normalizeSlashes(realpathSync(path.join(repositoryRoot, "node_modules", "three"))),
      version: threeManifest.version,
      inputs: threeInputs
    }
  });
}

function canonicalInputPath(input) {
  if (input.startsWith(`${singletonExternalNamespace}:`)) {
    return input;
  }
  const absolute = path.resolve(repositoryRoot, input);
  return normalizeSlashes(existsSync(absolute) ? realpathSync(absolute) : absolute);
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function writeJson(fileName, value) {
  writeFileSync(fileName, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}


if (isMainModule(import.meta.url)) {
  await buildBundleTarget(parseBundleArguments(process.argv.slice(2)));
}
