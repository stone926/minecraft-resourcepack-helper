#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const source = path.join(repoRoot, "packages", "rsgl-core", "src", "stdlib", "rsgl");
const [outputArgument, ...unexpectedArguments] = process.argv.slice(2);

if (outputArgument !== "out" || unexpectedArguments.length > 0) {
  throw new Error("Usage: node scripts/copy-rsgl-stdlib.mjs out");
}

const outputRoot = path.join(repoRoot, "out");
const compiledCoreRoot = path.join(outputRoot, "packages", "rsgl-core", "src");
if (!existsSync(compiledCoreRoot)) {
  process.exit(0);
}
const target = path.join(compiledCoreRoot, "stdlib", "rsgl");
rmSync(target, { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });
if (existsSync(source)) {
  cpSync(source, target, { recursive: true });
} else {
  mkdirSync(target, { recursive: true });
}
