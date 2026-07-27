#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstalledCliInvocation } from "./installed-cli-invocation.mjs";
import { runNpm } from "./npm-invocation.mjs";
import { releaseTargets } from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [archiveArgument] = process.argv.slice(2);
if (!archiveArgument) {
  throw new Error("Usage: verify-rsgl-cli-package.mjs <path-to-rsgl-cli.tgz>");
}

const archive = path.resolve(archiveArgument);
if (!existsSync(archive)) {
  throw new Error(`RSGL CLI package does not exist: ${archive}`);
}

const cliPackageName = readCliPackageName();

const installationRoot = mkdtempSync(path.join(tmpdir(), "rsgl-cli-install-"));
try {
  writeFileSync(path.join(installationRoot, "package.json"), "{\"private\":true}\n", "utf8");
  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    archive
  ], installationRoot, path.join(installationRoot, ".npm-cache"));

  const installedRoot = path.join(
    installationRoot,
    "node_modules",
    ...cliPackageName.split("/")
  );
  const manifest = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  const binPath = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rsgl;
  if (typeof binPath !== "string") {
    throw new Error("Installed RSGL CLI package does not declare bin.rsgl.");
  }
  const entry = path.resolve(installedRoot, binPath);
  if (!existsSync(entry)) {
    throw new Error(`Installed RSGL CLI entry point is missing: ${entry}`);
  }
  const shim = path.join(
    installationRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "rsgl.cmd" : "rsgl"
  );
  if (!existsSync(shim)) {
    throw new Error(`Installed RSGL CLI shim is missing: ${shim}`);
  }
  const result = runInstalledCli(entry, shim, ["--help"], installationRoot);
  if (result.error || result.status !== 0 || !result.stdout.includes("Usage: rsgl")) {
    throw new Error([
      "Installed RSGL CLI failed its --help smoke test.",
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  console.log(`RSGL CLI package smoke passed: ${archive}`);
} finally {
  rmSync(installationRoot, { recursive: true, force: true });
}

function readCliPackageName() {
  const manifestFile = path.join(repoRoot, releaseTargets["rsgl-cli"].manifestPath);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`RSGL CLI package manifest has no name: ${manifestFile}`);
  }
  return manifest.name;
}

function runInstalledCli(entry, shim, args, cwd) {
  const invocation = resolveInstalledCliInvocation(entry, shim, args);
  return spawnSync(invocation.file, invocation.args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}
