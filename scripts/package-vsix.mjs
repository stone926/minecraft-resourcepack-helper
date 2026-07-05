#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const targets = {
  main: {
    cwd: repoRoot,
    defaultArgs: [],
  },
  rsgl: {
    cwd: path.join(repoRoot, "extensions", "vscode-rsgl"),
    defaultArgs: ["--skip-license"],
  },
};

const [targetName, ...rawArgs] = process.argv.slice(2);
const target = targets[targetName];

if (!target) {
  console.error(`Usage: node scripts/package-vsix.mjs <${Object.keys(targets).join("|")}> [vsce package args...]`);
  process.exit(1);
}

const args = normalizeOutputArgs(rawArgs);
const vsce = path.join(repoRoot, "node_modules", "@vscode", "vsce", "vsce");

execFileSync(process.execPath, [vsce, "package", ...target.defaultArgs, ...args], {
  cwd: target.cwd,
  stdio: "inherit",
});

function normalizeOutputArgs(args) {
  const normalized = [...args];

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];

    if ((arg === "--out" || arg === "-o") && normalized[index + 1]) {
      normalized[index + 1] = resolveRepoRelativePath(normalized[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      normalized[index] = `--out=${resolveRepoRelativePath(arg.slice("--out=".length))}`;
    }
  }

  return normalized;
}

function resolveRepoRelativePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}
