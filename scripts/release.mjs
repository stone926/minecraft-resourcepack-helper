#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  hasChangelogSection,
  insertReleaseSection,
  selectReleaseNotes
} from "./release-changelog.mjs";
import {
  releaseTag,
  releaseTarget,
  targetDirectory
} from "./release-targets.mjs";
import { captureGitRemote, pushReleaseRefs } from "./release-push.mjs";
import { resolveNextReleaseVersion } from "./release-version.mjs";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

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
    "Usage: release.mjs [main|rsgl-cli] [current|patch|minor|major|x.y.z] "
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
  : resolveNextReleaseVersion(currentVersion, releaseInput, {
    manifestPath: target.manifestPath
  });
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
  run(process.execPath, ["scripts/build.mjs", "all", "--bundle-mode", "production"]);

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

function releaseNotesForTarget(changelogPath, version) {
  if (!existsSync(changelogPath)) {
    return ["- Maintenance release."];
  }
  return selectReleaseNotes(readFileSync(changelogPath, "utf8"), {
    version,
    taggingCurrentVersion
  });
}

function updateChangelog(changelogPath, version, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const content = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "# Changelog\n\n## [Unreleased]\n\n";
  if (content.includes(`## [${version}]`)) {
    fail(`${changelogPath} already contains an entry for ${version}.`);
  }
  writeFileSync(changelogPath, insertReleaseSection(content, {
    version,
    date,
    notes
  }), "utf8");
}

function changelogHasVersion(changelogPath, version) {
  return existsSync(changelogPath)
    && hasChangelogSection(readFileSync(changelogPath, "utf8"), version);
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
  console.log("- node scripts/build.mjs all --bundle-mode production");
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
  const invocation = command === "npm"
    ? resolveNpmInvocation(commandArgs)
    : { file: command, args: commandArgs };
  execFileSync(invocation.file, invocation.args, { stdio: "inherit" });
}

function capture(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function fail(message) {
  throw new Error(message);
}
