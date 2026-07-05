#!/usr/bin/env node

import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

for (const relativePath of ["out"]) {
  rmSync(path.join(repoRoot, relativePath), { recursive: true, force: true });
}
