#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));

const knownFlags = new Set(["--dry-run", "--skip-tests", "--no-push"]);
for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    fail(`Unknown flag: ${flag}`);
  }
}

if (positional.length > 1) {
  fail("Usage: npm run release -- [patch|minor|major|x.y.z] [--dry-run] [--skip-tests] [--no-push]");
}

const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");
const noPush = flags.has("--no-push");
const releaseInput = positional[0] ?? "patch";

const packagePath = "package.json";
const lockPath = "package-lock.json";
const rsglPackagePath = "extensions/vscode-rsgl/package.json";
const rsglLockPath = "extensions/vscode-rsgl/package-lock.json";
const changelogPath = "CHANGELOG.md";
const rsglChangelogPath = "extensions/vscode-rsgl/CHANGELOG.md";
const remoteName = "origin";

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const currentVersion = pkg.version;
const nextVersion = resolveNextVersion(currentVersion, releaseInput);
const tagName = `v${nextVersion}`;

main();

function main() {
  assertGitRepo();
  assertRemoteExists(remoteName);
  assertSplitPackageVersionsMatch();

  const status = getGitStatus();
  if (status) {
    if (!dryRun) {
      fail(
        [
          "Working tree is not clean. Commit or stash changes before publishing.",
          "Dirty files:",
          status,
        ].join("\n"),
      );
    }

    console.warn("Working tree is not clean; dry run will continue.");
  }

  assertTagDoesNotExist(tagName);

  const releaseBase = getReleaseBase();
  const notes = getReleaseNotes(releaseBase);

  printPlan(releaseBase, notes);

  if (dryRun) {
    console.log("Dry run complete. No files were changed.");
    return;
  }

  if (!skipTests) {
    run("npm", ["test"]);
  }
  run("npm", ["run", "compile:all"]);

  run("npm", ["version", nextVersion, "--no-git-tag-version"]);
  if (existsSync(rsglPackagePath)) {
    run("npm", ["--prefix", "extensions/vscode-rsgl", "version", nextVersion, "--no-git-tag-version"]);
  }
  updateChangelog(changelogPath, nextVersion, notes);
  if (existsSync(rsglChangelogPath)) {
    updateChangelog(rsglChangelogPath, nextVersion, notes);
  }

  const filesToStage = [packagePath, lockPath, rsglPackagePath, rsglLockPath, changelogPath, rsglChangelogPath].filter((file) => existsSync(file));
  run("git", ["add", ...filesToStage]);
  run("git", ["commit", "-m", `chore: release ${tagName}`]);
  run("git", ["tag", "-a", tagName, "-m", tagName]);

  if (noPush) {
    console.log(`Created local release commit and tag ${tagName}. Push them when ready.`);
    return;
  }

  run("git", ["push", remoteName, "HEAD", "--follow-tags"]);
  console.log(`Pushed ${tagName}. GitHub Actions will test, package, publish, and create the release.`);
}

function resolveNextVersion(version, input) {
  const parsed = parseVersion(version);
  if (!parsed) {
    fail(`package.json version is not a plain semver version: ${version}`);
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
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  return 0;
}

function assertSplitPackageVersionsMatch() {
  if (!existsSync(rsglPackagePath)) {
    return;
  }

  const rsglPkg = JSON.parse(readFileSync(rsglPackagePath, "utf8"));
  if (rsglPkg.version !== currentVersion) {
    fail(`${rsglPackagePath} version ${rsglPkg.version} does not match ${packagePath} version ${currentVersion}.`);
  }
}

function getReleaseBase() {
  const lastTag = getLastTag();
  if (lastTag) {
    return {
      label: `${lastTag}..HEAD`,
      range: `${lastTag}..HEAD`,
    };
  }

  const upstream = getUpstream();
  if (upstream) {
    return {
      label: `${upstream}..HEAD`,
      range: `${upstream}..HEAD`,
    };
  }

  return {
    label: "full history",
    range: "HEAD",
  };
}

function getLastTag() {
  try {
    return capture("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  } catch {
    return "";
  }
}

function getUpstream() {
  try {
    return capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  } catch {
    return "";
  }
}

function getReleaseNotes(releaseBase) {
  const unreleasedNotes = getUnreleasedNotes();
  if (unreleasedNotes.length > 0) {
    return unreleasedNotes;
  }

  let output = "";

  try {
    output = capture("git", ["log", releaseBase.range, "--pretty=format:%s (%h)"]);
  } catch {
    output = "";
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("chore: release v"));

  if (lines.length === 0) {
    return ["- Maintenance release."];
  }

  return lines.map((line) => `- ${line}`);
}

function getUnreleasedNotes() {
  if (!existsSync(changelogPath)) {
    return [];
  }

  const content = readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
  const section = findChangelogSection(content, "Unreleased");
  if (!section) {
    return [];
  }

  return section.body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function updateChangelog(targetChangelogPath, version, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## [${version}] - ${date}\n\n${notes.join("\n")}\n\n`;
  let content = "# Changelog\n\n";

  if (existsSync(targetChangelogPath)) {
    content = readFileSync(targetChangelogPath, "utf8");
  }

  content = content.replace(/\r\n/g, "\n");

  if (content.includes(`## [${version}]`)) {
    fail(`${targetChangelogPath} already contains an entry for ${version}.`);
  }

  if (!content.startsWith("# Changelog")) {
    content = `# Changelog\n\n${content}`;
  }

  const unreleasedSection = findChangelogSection(content, "Unreleased");
  if (unreleasedSection) {
    const before = content.slice(0, unreleasedSection.index);
    const after = content.slice(unreleasedSection.bodyEnd);
    content = `${before}${entry}${after.trimStart()}`;
  } else {
    const firstVersionIndex = content.search(/\n## \[/);
    if (firstVersionIndex === -1) {
      content = `${content.trimEnd()}\n\n${entry}`;
    } else {
      const prefix = content.slice(0, firstVersionIndex).trimEnd();
      const suffix = content.slice(firstVersionIndex).trimStart();
      content = `${prefix}\n\n${entry}${suffix}`;
    }
  }

  writeFileSync(targetChangelogPath, `${content.trimEnd()}\n`, "utf8");
}

function findChangelogSection(content, title) {
  const escapedTitle = escapeRegExp(title);
  const headingRegex = new RegExp(`^## \\[${escapedTitle}\\][^\\n]*\\n`, "m");
  const headingMatch = headingRegex.exec(content);
  if (!headingMatch) {
    return null;
  }

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const nextHeadingRegex = /^## \[/gm;
  nextHeadingRegex.lastIndex = bodyStart;

  const nextHeadingMatch = nextHeadingRegex.exec(content);
  const bodyEnd = nextHeadingMatch ? nextHeadingMatch.index : content.length;

  return {
    index: headingMatch.index,
    header: headingMatch[0],
    body: content.slice(bodyStart, bodyEnd),
    bodyEnd,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printPlan(releaseBase, notes) {
  console.log(`Release: ${pkg.name} ${currentVersion} -> ${nextVersion}`);
  console.log(`Tag: ${tagName}`);
  console.log(`Remote: ${remoteName}`);
  console.log(`Commit range: ${releaseBase.label}`);
  console.log("Release notes:");
  for (const note of notes) {
    console.log(note);
  }

  console.log("Steps:");
  if (!skipTests) {
    console.log("- npm test");
  } else {
    console.log("- tests skipped");
  }
  console.log("- npm run compile:all");
  console.log("- npm version --no-git-tag-version for both VS Code extensions");
  console.log("- update CHANGELOG.md files");
  console.log("- git commit and annotated tag");
  console.log(noPush ? "- skip push" : `- git push ${remoteName} HEAD --follow-tags`);
}

function assertGitRepo() {
  capture("git", ["rev-parse", "--is-inside-work-tree"]);
}

function assertRemoteExists(remote) {
  capture("git", ["remote", "get-url", remote]);
}

function assertTagDoesNotExist(tag) {
  const existingLocalTag = capture("git", ["tag", "--list", tag]);
  if (existingLocalTag) {
    fail(`Tag already exists locally: ${tag}`);
  }

  const existingRemoteTag = capture("git", ["ls-remote", "--tags", remoteName, `refs/tags/${tag}`]);
  if (existingRemoteTag) {
    fail(`Tag already exists on ${remoteName}: ${tag}`);
  }
}

function getGitStatus() {
  return capture("git", ["status", "--porcelain"]);
}

function run(command, commandArgs) {
  console.log(`> ${[command, ...commandArgs].join(" ")}`);
  const invocation = resolveInvocation(command, commandArgs);
  execFileSync(invocation.file, invocation.args, { stdio: "inherit" });
}

function capture(command, commandArgs) {
  const invocation = resolveInvocation(command, commandArgs);
  return execFileSync(invocation.file, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveInvocation(command, commandArgs) {
  if ((process.platform === "win32") && (command === "npm")) {
    const commandLine = ["npm", ...commandArgs].map(quoteCmdArg).join(" ");
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return {
    file: command,
    args: commandArgs,
  };
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
