#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./release-changelog.mjs";
import {
  parseReleaseTag,
  releaseAssetName
} from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optionSchemas = Object.freeze({
  describe: Object.freeze({
    values: Object.freeze(["tag", "output"]),
    flags: Object.freeze(["verify-git"])
  }),
  notes: Object.freeze({
    values: Object.freeze(["tag", "output"]),
    flags: Object.freeze([])
  }),
  digest: Object.freeze({
    values: Object.freeze(["asset", "output"]),
    flags: Object.freeze([])
  })
});

main();

function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const schema = typeof command === "string" && Object.hasOwn(optionSchemas, command)
    ? optionSchemas[command]
    : undefined;
  if (!schema) {
    fail("Usage: release-contract.mjs <describe|notes|digest> [options]");
  }
  const args = parseOptions(rawArgs, command, schema);
  if (command === "describe") {
    describeRelease(args);
    return;
  }
  if (command === "notes") {
    writeReleaseNotes(args);
    return;
  }
  if (command === "digest") {
    writeReleaseDigest(args);
    return;
  }
}

function describeRelease(args) {
  const tag = requiredOption(args, "tag");
  const { target, version } = parseReleaseTag(tag);
  const manifest = readJson(target.manifestPath);
  if (manifest.version !== version) {
    fail(
      `${target.manifestPath} version ${manifest.version ?? "<missing>"} does not match release tag ${tag}.`
    );
  }
  const commit = args.has("verify-git") ? verifyGitTag(tag) : undefined;
  const values = {
    product: target.id,
    version,
    tag,
    publish_kind: target.publishKind,
    asset_name: releaseAssetName(target, manifest, version),
    ...(target.publishKind === "marketplace"
      ? marketplaceCoordinates(manifest, target.manifestPath)
      : {}),
    ...(commit ? { commit } : {})
  };
  const output = serializeStepOutputs(values);
  if (args.has("output")) {
    appendFileSync(resolveRepoPath(requiredOption(args, "output")), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

function serializeStepOutputs(values) {
  return Object.entries(values).map(([key, value]) => {
    const serialized = String(value);
    if (/[\r\n]/.test(serialized)) {
      fail(`Release output ${key} must be a single line.`);
    }
    return `${key}=${serialized}\n`;
  }).join("");
}

function marketplaceCoordinates(manifest, manifestPath) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(manifest.publisher ?? "")) {
    fail(`${manifestPath} has an invalid Marketplace publisher.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(manifest.name ?? "")) {
    fail(`${manifestPath} has an invalid Marketplace extension name.`);
  }
  return {
    marketplace_publisher: manifest.publisher,
    marketplace_extension: manifest.name
  };
}

function writeReleaseNotes(args) {
  const tag = requiredOption(args, "tag");
  const output = resolveRepoPath(requiredOption(args, "output"));
  const { target, version } = parseReleaseTag(tag);
  const changelog = resolveRepoPath(target.changelogPath);
  const notes = existsSync(changelog)
    ? (changelogSection(readFileSync(changelog, "utf8"), version)?.trim() ?? "")
    : "";
  writeFileSync(output, `${notes || `Release ${tag}`}\n`, "utf8");
}

function writeReleaseDigest(args) {
  const asset = resolveRepoPath(requiredOption(args, "asset"));
  const output = resolveRepoPath(requiredOption(args, "output"));
  if (!existsSync(asset)) {
    fail(`Release asset does not exist: ${asset}`);
  }
  const digest = sha256(asset);
  writeFileSync(output, `${digest}  ${path.basename(asset)}\n`, "utf8");
  process.stdout.write(`${digest}\n`);
}

function verifyGitTag(tag) {
  const tagCommit = captureGit(["rev-list", "-n", "1", `refs/tags/${tag}`]);
  const headCommit = captureGit(["rev-parse", "HEAD"]);
  if (tagCommit !== headCommit) {
    fail(`Release tag ${tag} points to ${tagCommit}, but the checked-out commit is ${headCommit}.`);
  }
  return headCommit;
}

function sha256(fileName) {
  return createHash("sha256").update(readFileSync(fileName)).digest("hex");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolveRepoPath(relativePath), "utf8"));
}

function parseOptions(args, command, schema) {
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith("--")) {
      fail(`Unexpected positional argument: ${item}`);
    }
    const key = item.slice(2);
    const isFlag = schema.flags.includes(key);
    const hasValue = schema.values.includes(key);
    if (!isFlag && !hasValue) {
      fail(`Unknown option --${key} for ${command}.`);
    }
    if (options.has(key)) {
      fail(`Duplicate option --${key} for ${command}.`);
    }
    if (isFlag) {
      options.set(key, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    fail(`Missing required option --${name}.`);
  }
  return value;
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function captureGit(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function fail(message) {
  throw new Error(message);
}
