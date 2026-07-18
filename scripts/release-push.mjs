#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const transientTransportPatterns = [
  /connection (?:closed|reset|timed out|refused)/i,
  /operation timed out/i,
  /could not resolve (?:host|hostname)/i,
  /temporary failure/i,
  /network is unreachable/i,
  /remote end hung up unexpectedly/i,
  /early eof/i,
  /recv failure/i,
  /failed to connect/i,
  /tls.*(?:closed|terminated)/i,
  /rpc failed;.*(?:curl 5[256]|http 5\d\d)/i
];

export function isTransientGitTransportFailure(output) {
  return transientTransportPatterns.some(pattern => pattern.test(output));
}

/** Runs a read-only remote Git command with the same transport-only retry rule. */
export async function captureGitRemote(args, options = {}) {
  const {
    cwd = process.cwd(),
    maxAttempts = 3,
    runAttempt = defaultPushAttempt,
    sleep = delay,
    logger = console,
    writeOutput = defaultWriteOutput
  } = options;
  let lastOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger.info(`> git ${args.join(" ")}`);
    const result = await runAttempt(args, cwd);
    writeOutput(result.stdout ?? "", result.stderr ?? "");
    if (result.status === 0) {
      return (result.stdout ?? "").trim();
    }
    lastOutput = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");
    const canRetry = attempt < maxAttempts && isTransientGitTransportFailure(lastOutput);
    if (!canRetry) {
      break;
    }
    const waitMs = attempt * 2_000;
    logger.warn(
      `Transient Git transport failure (${attempt}/${maxAttempts}); retrying in ${waitMs / 1_000}s.`
    );
    await sleep(waitMs);
  }

  throw new Error([
    `Git remote command failed: git ${args.join(" ")}`,
    lastOutput.trim()
  ].filter(Boolean).join("\n"));
}

/**
 * Atomically pushes the release branch and exactly one tag. A bounded retry is
 * used only for transport failures; authentication and ref-policy failures are
 * surfaced immediately. A readback closes the ambiguity where the server
 * accepted both refs but the SSH connection dropped before acknowledgement.
 */
export async function pushReleaseRefs(options) {
  const {
    remoteName,
    branchName,
    tagName,
    expectedCommit,
    expectedTagObject,
    resumeCommand,
    cwd = process.cwd(),
    maxAttempts = 3,
    pushAttempt = defaultPushAttempt,
    readBack = defaultReadBack,
    sleep = delay,
    logger = console,
    writeOutput = defaultWriteOutput
  } = options;

  if (!remoteName || !branchName || !tagName || !expectedCommit || !expectedTagObject) {
    throw new Error(
      "Atomic release push requires a remote, branch, tag, expected commit, and tag object."
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Atomic release push maxAttempts must be a positive integer.");
  }

  const tagRef = `refs/tags/${tagName}`;
  const branchRef = `refs/heads/${branchName}`;
  const pushArgs = ["push", "--atomic", remoteName, `HEAD:${branchRef}`, tagRef];
  let lastOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger.info(`> git ${pushArgs.join(" ")}`);
    const result = await pushAttempt(pushArgs, cwd);
    writeOutput(result.stdout ?? "", result.stderr ?? "");
    if (result.status === 0) {
      return;
    }

    lastOutput = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");
    const accepted = await readBack({
      remoteName,
      branchRef,
      tagRef,
      expectedCommit,
      expectedTagObject,
      cwd
    });
    if (accepted) {
      logger.warn(
        "The push connection ended with an error, but remote readback verified both release refs."
      );
      return;
    }

    const canRetry = attempt < maxAttempts && isTransientGitTransportFailure(lastOutput);
    if (!canRetry) {
      break;
    }
    const waitMs = attempt * 2_000;
    logger.warn(
      `Transient Git transport failure (${attempt}/${maxAttempts}); retrying in ${waitMs / 1_000}s.`
    );
    await sleep(waitMs);
  }

  const recoveryCommand = `git ${pushArgs.join(" ")}`;
  throw new Error([
    `Unable to atomically push ${tagName}.`,
    "The local release commit and annotated tag were kept; no rollback was performed.",
    ...(resumeCommand ? [
      "After fixing the connection or credentials, use the checked resume path:",
      `  ${resumeCommand}`,
      "Equivalent atomic ref push:"
    ] : ["After fixing the connection or credentials, retry with:"]),
    `  ${recoveryCommand}`,
    lastOutput.trim() ? `Last Git output:\n${lastOutput.trim()}` : ""
  ].filter(Boolean).join("\n"));
}

function defaultPushAttempt(args, cwd) {
  return runGit(args, cwd);
}

function defaultReadBack({
  remoteName,
  branchRef,
  tagRef,
  expectedCommit,
  expectedTagObject,
  cwd
}) {
  const peeledTagRef = `${tagRef}^{}`;
  const result = runGit(
    ["ls-remote", remoteName, branchRef, tagRef, peeledTagRef],
    cwd
  );
  if (result.status !== 0) {
    return false;
  }
  const refs = new Map(result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.trim().split(/\s+/, 2)));
  const remoteTagCommit = refs.get(peeledTagRef) ?? refs.get(tagRef);
  return refs.get(branchRef) === expectedCommit
    && refs.get(tagRef) === expectedTagObject
    && remoteTagCommit === expectedCommit;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"]
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function defaultWriteOutput(stdout, stderr) {
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
