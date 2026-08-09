#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { executeNodeSteps, nodeStep } from "./lib/steps.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleModes } from "./build-bundles.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), "..");

export const buildProfiles = Object.freeze({
  main: Object.freeze({
    tsconfig: "tsconfig.vsix.json",
    bundleTarget: "main"
  }),
  rsgl: Object.freeze({
    tsconfig: "tsconfig.rsgl-host.json",
    bundleTarget: "rsgl"
  }),
  "rsgl-cli": Object.freeze({
    tsconfig: "packages/rsgl-cli/tsconfig.json",
    bundleTarget: "rsgl-cli"
  }),
  all: Object.freeze({
    tsconfig: "tsconfig.json",
    bundleTarget: "all",
    stdlibOutputs: Object.freeze(["out"])
  }),
  test: Object.freeze({
    tsconfig: "tsconfig.tests.json",
    bundleTarget: null,
    stdlibOutputs: Object.freeze(["out"]),
    pruneStaleTypeScriptOutputs: true
  })
});

export function createBuildPlan(targetName, options = {}) {
  const profile = buildProfiles[targetName];
  if (!profile) {
    throw new Error(
      `Unknown build target '${targetName}'. Expected ${Object.keys(buildProfiles).join(", ")}.`
    );
  }

  const mode = options.mode ?? "build";
  if (!new Set(["build", "typecheck", "bundle"]).has(mode)) {
    throw new Error(`Unknown build mode '${mode}'. Expected build, typecheck, or bundle.`);
  }
  const bundleMode = options.bundleMode ?? "development";
  if (!bundleModes.includes(bundleMode)) {
    throw new Error(`Unknown bundle mode '${bundleMode}'. Expected ${bundleModes.join(", ")}.`);
  }
  if (mode === "bundle" && profile.bundleTarget === null) {
    throw new Error(`Build target '${targetName}' does not produce a distributable bundle.`);
  }
  if (mode === "typecheck" && bundleMode !== "development") {
    throw new Error("--bundle-mode cannot be used with --typecheck-only.");
  }

  const plan = [];
  if (profile.pruneStaleTypeScriptOutputs && mode !== "bundle") {
    plan.push(nodeStep(
      "prune stale TypeScript outputs",
      "scripts/prune-stale-typescript-outputs.mjs"
    ));
  }
  if (mode !== "bundle") {
    plan.push(nodeStep(
      `typecheck ${targetName}`,
      "node_modules/typescript/bin/tsc",
      ["-b", profile.tsconfig]
    ));
    for (const output of profile.stdlibOutputs ?? []) {
      plan.push(nodeStep(
        `copy RSGL stdlib to ${output}`,
        "scripts/copy-rsgl-stdlib.mjs",
        [output]
      ));
    }
  }
  if (mode !== "typecheck" && profile.bundleTarget !== null) {
    plan.push(nodeStep(
      `bundle ${targetName} (${bundleMode})`,
      "scripts/build-bundles.mjs",
      [profile.bundleTarget, "--bundle-mode", bundleMode]
    ));
  }
  return plan;
}

export function executeBuildPlan(plan, options = {}) {
  executeNodeSteps(plan, { repositoryRoot, ...options });
}

export function parseBuildArguments(args) {
  const [targetName, ...flags] = args;
  if (!targetName) {
    throw new Error(
      "Usage: node scripts/build.mjs <main|rsgl|rsgl-cli|all|test> "
        + "[--typecheck-only|--bundle-only] "
        + "[--bundle-mode <development|production|analyze>]"
    );
  }
  let mode = "build";
  let bundleMode = "development";
  let hasBundleMode = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--typecheck-only" && mode === "build") {
      mode = "typecheck";
      continue;
    }
    if (flag === "--bundle-only" && mode === "build") {
      mode = "bundle";
      continue;
    }
    if (flag === "--typecheck-only" || flag === "--bundle-only") {
      throw new Error("--typecheck-only and --bundle-only cannot be combined.");
    }
    if (flag === "--bundle-mode") {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      const value = flags[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --bundle-mode.");
      }
      bundleMode = value;
      hasBundleMode = true;
      index += 1;
      continue;
    }
    if (flag.startsWith("--bundle-mode=")) {
      if (hasBundleMode) {
        throw new Error("--bundle-mode may only be specified once.");
      }
      bundleMode = flag.slice("--bundle-mode=".length);
      hasBundleMode = true;
      continue;
    }
    throw new Error(`Unknown build flag: ${flag}`);
  }
  const parsed = { targetName, mode, bundleMode };
  createBuildPlan(targetName, parsed);
  return parsed;
}


if (isMainModule(import.meta.url)) {
  const options = parseBuildArguments(process.argv.slice(2));
  executeBuildPlan(createBuildPlan(options.targetName, options));
}
