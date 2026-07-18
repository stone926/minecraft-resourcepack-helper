#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), "..");

export const buildProfiles = Object.freeze({
  main: Object.freeze({
    tsconfig: "tsconfig.main.json",
    bundleArgs: Object.freeze(["main"])
  }),
  rsgl: Object.freeze({
    tsconfig: "extensions/vscode-rsgl/tsconfig.json",
    bundleArgs: Object.freeze(["rsgl"])
  }),
  "rsgl-cli": Object.freeze({
    tsconfig: "packages/rsgl-cli/tsconfig.json",
    bundleArgs: Object.freeze(["cli"])
  }),
  all: Object.freeze({
    tsconfig: "tsconfig.json",
    bundleArgs: Object.freeze([]),
    stdlibOutputs: Object.freeze(["out"])
  }),
  test: Object.freeze({
    tsconfig: "tsconfig.tests.json",
    bundleArgs: null,
    stdlibOutputs: Object.freeze(["out"]),
    cleanFirst: true
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
  if (mode === "bundle" && profile.bundleArgs === null) {
    throw new Error(`Build target '${targetName}' does not produce a distributable bundle.`);
  }

  const plan = [];
  if (profile.cleanFirst && mode !== "bundle") {
    plan.push(nodeStep("clean generated outputs", "scripts/clean.mjs"));
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
  if (mode !== "typecheck" && profile.bundleArgs !== null) {
    plan.push(nodeStep(
      `bundle ${targetName}`,
      "scripts/build-bundles.mjs",
      [...profile.bundleArgs]
    ));
  }
  return plan;
}

export function executeBuildPlan(plan, options = {}) {
  const executeStep = options.executeStep ?? defaultExecuteStep;
  const logger = options.logger ?? console;
  for (const step of plan) {
    logger.log(`> node ${step.script}${step.args.length > 0 ? ` ${step.args.join(" ")}` : ""}`);
    executeStep(step, { repositoryRoot });
  }
}

export function parseBuildArguments(args) {
  const [targetName, ...flags] = args;
  if (!targetName) {
    throw new Error(
      "Usage: node scripts/build.mjs <main|rsgl|rsgl-cli|all|test> "
        + "[--typecheck-only|--bundle-only]"
    );
  }
  let mode = "build";
  for (const flag of flags) {
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
    throw new Error(`Unknown build flag: ${flag}`);
  }
  return { targetName, mode };
}

function nodeStep(label, script, args = []) {
  return Object.freeze({ label, script, args: Object.freeze(args) });
}

function defaultExecuteStep(step, context) {
  execFileSync(
    process.execPath,
    [path.resolve(context.repositoryRoot, step.script), ...step.args],
    { cwd: context.repositoryRoot, stdio: "inherit" }
  );
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
  const { targetName, mode } = parseBuildArguments(process.argv.slice(2));
  executeBuildPlan(createBuildPlan(targetName, { mode }));
}
