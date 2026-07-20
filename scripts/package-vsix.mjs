#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareVsixPackageArguments } from "./vsix-package-output.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const targets = {
  main: {
    cwd: path.join(repoRoot, "dist", "vsix-stage", "main"),
    defaultArgs: ["--no-dependencies"],
  },
};

const [targetName, ...rawArgs] = process.argv.slice(2);
const target = targets[targetName];

if (!target) {
  console.error(`Usage: node scripts/package-vsix.mjs <${Object.keys(targets).join("|")}> [vsce package args...]`);
  process.exit(1);
}

const args = prepareVsixPackageArguments(rawArgs, repoRoot);
const vsce = path.join(repoRoot, "node_modules", "@vscode", "vsce", "vsce");
const sourceDateEpoch = resolveSourceDateEpoch();

execFileSync(process.execPath, [vsce, "package", ...target.defaultArgs, ...args], {
  cwd: target.cwd,
  stdio: "inherit",
  env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
});

function resolveSourceDateEpoch() {
  const configured = process.env.SOURCE_DATE_EPOCH;
  if (configured !== undefined) {
    return validateSourceDateEpoch(configured, "SOURCE_DATE_EPOCH");
  }

  let commitTimestamp;
  try {
    commitTimestamp = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${repoRoot.replaceAll("\\", "/")}`,
        "show",
        "-s",
        "--format=%ct",
        "HEAD"
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch (error) {
    throw new Error(
      "VSIX packaging requires SOURCE_DATE_EPOCH or a Git checkout to produce reproducible archives.",
      { cause: error }
    );
  }
  return validateSourceDateEpoch(commitTimestamp, "HEAD commit timestamp");
}

function validateSourceDateEpoch(value, source) {
  const timestamp = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(timestamp)
    || timestamp < 315532800 || timestamp > 4354819199) {
    throw new Error(`${source} must be a Unix timestamp supported by ZIP (1980 through 2107).`);
  }
  return value;
}
