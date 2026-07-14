#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatRsglBenchmarkCsv,
  runRsglBenchmarks
} from "./rsgl-benchmark/runner.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const coreFile = path.join(repositoryRoot, "out", "packages", "rsgl-core", "src", "index.js");
const profileName = parseProfile(process.argv.slice(2));

if (!fs.existsSync(coreFile)) {
  throw new Error(`Missing compiled RSGL core at ${coreFile}. Run npm run compile first.`);
}

const coreNamespace = await import(pathToFileURL(coreFile).href);
const core = coreNamespace.default ?? coreNamespace;
const rows = runRsglBenchmarks(core, profileName);
process.stdout.write(formatRsglBenchmarkCsv(rows));

function parseProfile(args) {
  if (args.length === 0) {
    return "default";
  }
  if (args.length === 1 && args[0] === "--smoke") {
    return "smoke";
  }
  throw new Error("Usage: node scripts/rsgl-benchmark.mjs [--smoke]");
}
