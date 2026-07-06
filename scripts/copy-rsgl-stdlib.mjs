#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const source = path.join(repoRoot, "packages", "rsgl-core", "src", "stdlib", "rsgl");
const outputRoots = [
  path.join(repoRoot, "out"),
  path.join(repoRoot, "extensions", "vscode-rsgl", "out")
];

if (!existsSync(source)) {
  throw new Error(`RSGL stdlib source directory not found: ${source}`);
}

for (const outputRoot of outputRoots) {
  const compiledCoreRoot = path.join(outputRoot, "packages", "rsgl-core", "src");
  if (!existsSync(compiledCoreRoot)) {
    continue;
  }
  const target = path.join(compiledCoreRoot, "stdlib", "rsgl");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
