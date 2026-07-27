#!/usr/bin/env node

import { isMainModule } from "./lib/moduleIdentity.mjs";
import { executeNodeSteps, nodeStep } from "./lib/steps.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), "..");
const targetNames = Object.freeze(["main", "rsgl-cli"]);

export function createArtifactPlan(command, targetName, args = []) {
  assertTarget(targetName);
  if (command === "package") {
    if (targetName === "main") {
      return [
        nodeStep(
          "build combined extension once",
          "scripts/build.mjs",
          ["main", "--bundle-mode", "production"]
        ),
        nodeStep("assemble combined VSIX stage", "scripts/assemble-main-vsix-stage.mjs"),
        nodeStep("package combined extension", "scripts/package-vsix.mjs", ["main", ...args])
      ];
    }
    return [nodeStep("package rsgl-cli", "scripts/package-rsgl-cli.mjs", [...args])];
  }

  if (command === "verify") {
    if (args.length !== 1) {
      throw new Error("Artifact verification requires exactly one artifact path.");
    }
    const [artifactPath] = args;
    if (typeof artifactPath !== "string" || artifactPath.length === 0) {
      throw new Error("Artifact verification requires a non-empty artifact path.");
    }
    if (targetName === "main") {
      return [
        nodeStep("verify combined extension runtime", "scripts/verify-main-vsix.mjs", [artifactPath]),
        budgetStep("main", artifactPath, "production")
      ];
    }
    return [
      nodeStep(
        "verify rsgl-cli package",
        "scripts/verify-rsgl-cli-package.mjs",
        [artifactPath]
      ),
      budgetStep("rsgl-cli", undefined, "production")
    ];
  }

  throw new Error(`Unknown artifact command '${command}'. Expected package or verify.`);
}

export function executeArtifactPlan(plan, options = {}) {
  executeNodeSteps(plan, { repositoryRoot, ...options });
}

export function parseArtifactArguments(args) {
  const [command, targetName, ...commandArgs] = args;
  if (!command || !targetName) {
    throw new Error(
      "Usage: node scripts/artifact.mjs <package|verify> <main|rsgl-cli> [arguments]"
    );
  }
  return { command, targetName, commandArgs };
}

function assertTarget(targetName) {
  if (!targetNames.includes(targetName)) {
    throw new Error(`Unknown artifact target '${targetName}'. Expected ${targetNames.join(", ")}.`);
  }
}

function budgetStep(targetName, artifactPath, bundleMode) {
  const args = ["--target", targetName];
  if (artifactPath !== undefined) {
    args.push("--artifact", artifactPath);
  }
  if (bundleMode !== undefined) {
    args.push("--bundle-mode", bundleMode);
  }
  return nodeStep(`verify ${targetName} budgets`, "scripts/verify-build-budgets.mjs", args);
}


if (isMainModule(import.meta.url)) {
  const { command, targetName, commandArgs } = parseArtifactArguments(process.argv.slice(2));
  executeArtifactPlan(createArtifactPlan(command, targetName, commandArgs));
}
