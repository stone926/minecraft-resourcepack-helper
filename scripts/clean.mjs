#!/usr/bin/env node

import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const supportedPaths = ["out", "extensions/vscode-rsgl/out"];
const requestedPaths = process.argv.slice(2);
const relativePaths = requestedPaths.length > 0 ? requestedPaths : supportedPaths;

for (const relativePath of relativePaths) {
  if (!supportedPaths.includes(relativePath)) {
    throw new Error(`Unsupported clean target: ${relativePath}`);
  }
  rmSync(path.join(repoRoot, relativePath), { recursive: true, force: true });
}
