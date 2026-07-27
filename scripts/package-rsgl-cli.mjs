#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./npm-invocation.mjs";
import { npmArchiveBaseName } from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "packages", "rsgl-cli");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const defaultOutput = path.join(
  repoRoot,
  "dist",
  `${npmArchiveBaseName(manifest.name)}-${manifest.version}.tgz`
);
const output = resolveOutput(process.argv.slice(2));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "rsgl-cli-pack-"));
const archiveRoot = path.join(temporaryRoot, "archive");
const npmCacheRoot = path.join(temporaryRoot, "npm-cache");

try {
  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(npmCacheRoot, { recursive: true });
  runNpm(
    ["pack", "--foreground-scripts", "--pack-destination", archiveRoot],
    packageRoot,
    npmCacheRoot
  );
  const archives = readdirSync(archiveRoot).filter(fileName => fileName.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected npm pack to create one archive, received ${archives.length}.`);
  }
  const source = path.join(archiveRoot, archives[0]);
  if (!existsSync(source)) {
    throw new Error(`npm pack did not create ${source}.`);
  }
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(source, output);
  console.log(`Created ${output}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function resolveOutput(args) {
  if (args.length === 0) {
    return defaultOutput;
  }
  if (args.length === 2 && (args[0] === "--out" || args[0] === "-o")) {
    return path.resolve(repoRoot, args[1]);
  }
  if (args.length === 1 && args[0].startsWith("--out=")) {
    return path.resolve(repoRoot, args[0].slice("--out=".length));
  }
  throw new Error("Usage: package-rsgl-cli.mjs [--out <archive.tgz>]");
}
