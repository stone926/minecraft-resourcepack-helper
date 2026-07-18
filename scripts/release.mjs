#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  releaseTag,
  releaseTarget,
  targetDirectory
} from "./release-targets.mjs";
import { captureGitRemote, pushReleaseRefs } from "./release-push.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter(argument => argument.startsWith("--")));
const positional = args.filter(argument => !argument.startsWith("--"));
const knownFlags = new Set(["--dry-run", "--skip-tests", "--no-push", "--resume"]);

for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    fail(`Unknown flag: ${flag}`);
  }
}
if (positional.length > 2) {
  fail(
    "Usage: release.mjs [main|rsgl|rsgl-cli] [current|patch|minor|major|x.y.z] "
      + "[--dry-run] [--skip-tests] [--no-push] [--resume]"
  );
}

const target = releaseTarget(positional[0] ?? "main");
const releaseInput = positional[1] ?? "patch";
const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");
const noPush = flags.has("--no-push");
const resume = flags.has("--resume");
const remoteName = "origin";
const manifest = readJson(target.manifestPath);
const currentVersion = manifest.version;
const nextVersion = releaseInput === "current"
  ? currentVersion
  : resolveNextVersion(currentVersion, releaseInput);
const tagName = releaseTag(target, nextVersion);
const taggingCurrentVersion = nextVersion === currentVersion;

if (resume && releaseInput !== "current") {
  fail("--resume requires the explicit 'current' release input.");
}
if (resume && noPush) {
  fail("--resume cannot be combined with --no-push.");
}

await main();

async function main() {
  assertGitRepo();
  assertRemoteExists(remoteName);
  assertCleanWorkingTree();
  const branchName = currentBranch();
  const initialCommit = capture("git", ["rev-parse", "HEAD"]);
  await assertReleaseTagState(tagName, initialCommit);
  if (taggingCurrentVersion && releaseInput !== "current") {
    fail("Use the explicit 'current' release input when tagging the manifest's existing version.");
  }
  if (taggingCurrentVersion && !changelogHasVersion(target.changelogPath, currentVersion)) {
    fail(`${target.changelogPath} must contain a ${currentVersion} section before tagging ${tagName}.`);
  }

  const notes = releaseNotesForTarget(target.changelogPath, currentVersion);
  printPlan(notes, branchName);

  if (dryRun) {
    console.log("Dry run complete. No files were changed.");
    return;
  }

  if (!skipTests) {
    run("npm", ["test"]);
  }
  run("npm", ["run", "compile:all"]);

  if (!taggingCurrentVersion) {
    updateTargetVersion(nextVersion);
    updateChangelog(target.changelogPath, nextVersion, notes);
    const filesToStage = [target.manifestPath, target.lockPath, target.changelogPath]
      .filter(fileName => fileName && existsSync(fileName));
    run("git", ["add", ...filesToStage]);
    run("git", ["commit", "-m", `chore(release): ${target.id} ${tagName}`]);
  }

  if (!resume) {
    run("git", ["tag", "-a", tagName, "-m", tagName]);
  }
  if (noPush) {
    console.log(`Created local tag ${tagName}. Push it when ready.`);
    return;
  }
  const releaseCommit = capture("git", ["rev-parse", "HEAD"]);
  const releaseTagObject = capture("git", ["rev-parse", `refs/tags/${tagName}`]);
  await pushReleaseRefs({
    remoteName,
    branchName,
    tagName,
    expectedCommit: releaseCommit,
    expectedTagObject: releaseTagObject,
    resumeCommand: `node scripts/release.mjs ${target.id} current --resume --skip-tests`
  });
  console.log(`Pushed ${tagName}. The independent ${target.displayName} release workflow will publish it.`);
}

function updateTargetVersion(version) {
  const directory = targetDirectory(target);
  const npmArgs = ["version", version, "--no-git-tag-version"];
  if (!target.lockPath) {
    npmArgs.push("--package-lock=false");
  }
  if (directory === ".") {
    run("npm", npmArgs);
  } else {
    run("npm", ["--prefix", directory, ...npmArgs]);
  }
}

function resolveNextVersion(version, input) {
  const parsed = parseVersion(version);
  if (!parsed) {
    fail(`${target.manifestPath} version is not a plain semver version: ${version}`);
  }
  if (input === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (input === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (input === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  const exact = parseVersion(input);
  if (!exact) {
    fail(`Invalid release version or bump type: ${input}`);
  }
  if (compareVersions(exact, parsed) <= 0) {
    fail(`Next version ${input} must be greater than current version ${version}.`);
  }
  return input;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : null;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function releaseNotesForTarget(changelogPath, version) {
  if (!existsSync(changelogPath)) {
    return ["- Maintenance release."];
  }
  const content = readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
  if (taggingCurrentVersion) {
    const existing = findChangelogSection(content, version)?.body.trim();
    return existing
      ? existing.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean)
      : ["- Maintenance release."];
  }
  const unreleased = findChangelogSection(content, "Unreleased")?.body.trim();
  if (unreleased) {
    return unreleased.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  }
  return ["- Maintenance release."];
}

function updateChangelog(changelogPath, version, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## [${version}] - ${date}\n\n${notes.join("\n")}\n\n`;
  let content = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n")
    : "# Changelog\n\n## [Unreleased]\n\n";
  if (content.includes(`## [${version}]`)) {
    fail(`${changelogPath} already contains an entry for ${version}.`);
  }
  if (!content.startsWith("# Changelog")) {
    content = `# Changelog\n\n${content}`;
  }
  const unreleased = findChangelogSection(content, "Unreleased");
  if (unreleased) {
    const beforeBody = content.slice(0, unreleased.bodyStart);
    const afterBody = content.slice(unreleased.bodyEnd).trimStart();
    content = `${beforeBody}\n${entry}${afterBody}`;
  } else {
    const firstVersion = content.search(/\n## \[/);
    content = firstVersion < 0
      ? `${content.trimEnd()}\n\n${entry}`
      : `${content.slice(0, firstVersion).trimEnd()}\n\n${entry}${content.slice(firstVersion).trimStart()}`;
  }
  writeFileSync(changelogPath, `${content.trimEnd()}\n`, "utf8");
}

function findChangelogSection(content, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, "m").exec(content);
  if (!match) {
    return null;
  }
  const bodyStart = match.index + match[0].length;
  const nextHeading = /^## \[/gm;
  nextHeading.lastIndex = bodyStart;
  const next = nextHeading.exec(content);
  return {
    body: content.slice(bodyStart, next?.index ?? content.length),
    bodyStart,
    bodyEnd: next?.index ?? content.length
  };
}

function changelogHasVersion(changelogPath, version) {
  return existsSync(changelogPath)
    && Boolean(findChangelogSection(readFileSync(changelogPath, "utf8"), version));
}

function printPlan(notes, branchName) {
  console.log(`Release target: ${target.displayName}`);
  console.log(`Version: ${currentVersion}${taggingCurrentVersion ? " (tag current)" : ` -> ${nextVersion}`}`);
  console.log(`Tag: ${tagName}`);
  console.log("Release notes:");
  for (const note of notes) {
    console.log(note);
  }
  console.log("Steps:");
  console.log(skipTests ? "- tests skipped" : "- npm test");
  console.log("- npm run compile:all");
  if (!taggingCurrentVersion) {
    console.log(`- update only ${target.manifestPath}${target.lockPath ? `, ${target.lockPath}` : ""}, and ${target.changelogPath}`);
    console.log("- create a target-specific release commit");
  }
  console.log(resume ? `- reuse annotated local tag ${tagName}` : `- create annotated tag ${tagName}`);
  console.log(noPush
    ? "- skip push"
    : `- atomically push ${branchName} and only ${tagName} to ${remoteName} (transport retry enabled)`);
}

function assertGitRepo() {
  capture("git", ["rev-parse", "--is-inside-work-tree"]);
}

function assertRemoteExists(remote) {
  capture("git", ["remote", "get-url", remote]);
}

function assertCleanWorkingTree() {
  const status = capture("git", ["status", "--porcelain"]);
  if (status && !dryRun) {
    fail(`Working tree is not clean. Commit or stash changes before publishing.\n${status}`);
  }
  if (status) {
    console.warn("Working tree is not clean; dry run will continue without changing files.");
  }
}

function currentBranch() {
  const branch = capture("git", ["branch", "--show-current"]);
  if (!branch) {
    fail("Release requires a checked-out branch; detached HEAD cannot be pushed safely.");
  }
  return branch;
}

async function assertReleaseTagState(tag, expectedCommit) {
  const localTag = capture("git", ["tag", "--list", tag]);
  const remoteOutput = await captureGitRemote([
    "ls-remote",
    "--tags",
    remoteName,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`
  ]);
  const remoteState = remoteTagState(remoteOutput, tag);

  if (!resume) {
    if (localTag) {
      fail(`Tag already exists locally: ${tag}`);
    }
    if (remoteState.object) {
      fail(`Tag already exists on ${remoteName}: ${tag}`);
    }
    return;
  }

  if (!localTag) {
    fail(`Cannot resume because the local tag does not exist: ${tag}`);
  }
  if (capture("git", ["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") {
    fail(`Cannot resume because ${tag} is not an annotated tag.`);
  }
  const localCommit = capture("git", ["rev-list", "-n", "1", tag]);
  const localObject = capture("git", ["rev-parse", `refs/tags/${tag}`]);
  if (localCommit !== expectedCommit) {
    fail(`Cannot resume because ${tag} points to ${localCommit}, not HEAD ${expectedCommit}.`);
  }
  if (remoteState.object && remoteState.object !== localObject) {
    fail(`Cannot resume because ${remoteName}/${tag} is not the same annotated tag object.`);
  }
  if (remoteState.commit && remoteState.commit !== expectedCommit) {
    fail(`Cannot resume because ${remoteName}/${tag} points to ${remoteState.commit}.`);
  }
}

function remoteTagState(output, tag) {
  const refs = new Map(output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.trim().split(/\s+/, 2)));
  const object = refs.get(`refs/tags/${tag}`) ?? "";
  return {
    object,
    commit: refs.get(`refs/tags/${tag}^{}`) ?? object
  };
}

function readJson(fileName) {
  return JSON.parse(readFileSync(fileName, "utf8"));
}

function run(command, commandArgs) {
  console.log(`> ${[command, ...commandArgs].join(" ")}`);
  const invocation = resolveInvocation(command, commandArgs);
  execFileSync(invocation.file, invocation.args, { stdio: "inherit" });
}

function capture(command, commandArgs) {
  const invocation = resolveInvocation(command, commandArgs);
  try {
    return execFileSync(invocation.file, invocation.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (command === "git" && commandArgs[0] === "ls-remote") {
      throw error;
    }
    throw error;
  }
}

function resolveInvocation(command, commandArgs) {
  if (process.platform === "win32" && command === "npm") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", ["npm", ...commandArgs].map(quoteCmdArg).join(" ")]
    };
  }
  return { file: command, args: commandArgs };
}

function quoteCmdArg(value) {
  return /^[A-Za-z0-9_./:=@+\\-]+$/.test(value)
    ? value
    : `"${value.replace(/"/g, '\\"')}"`;
}

function fail(message) {
  throw new Error(message);
}
