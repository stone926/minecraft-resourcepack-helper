#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import {
  copyRuntimeAssets,
  createBundlePlan,
  createEsbuildOptions
} from "./build-bundles.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = createBundlePlan("main", "development");
const contexts = [];
let shuttingDown = false;

copyRuntimeAssets(plan);
for (const item of plan) {
  const outfile = path.join(repositoryRoot, item.definition.outfile);
  mkdirSync(path.dirname(outfile), { recursive: true });
  const buildContext = await context(createEsbuildOptions(item.definition, "development"));
  contexts.push(buildContext);
  await buildContext.watch();
}

const typecheck = spawn(process.execPath, [
  path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
  "-b",
  "tsconfig.vsix.json",
  "--watch",
  "--preserveWatchOutput"
], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true
});

typecheck.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`TypeScript watch stopped (${signal ?? code ?? "unknown"}).`);
    void shutdown(code ?? 1);
  }
});
typecheck.on("error", error => {
  console.error(error);
  void shutdown(1);
});
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (typecheck.exitCode === null) {
    typecheck.kill();
  }
  await Promise.all(contexts.splice(0).map(buildContext => buildContext.dispose()));
  process.exitCode = exitCode;
}
