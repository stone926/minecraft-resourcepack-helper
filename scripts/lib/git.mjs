import { execFileSync } from "node:child_process";

/** Shared local Git readers for build and measurement scripts (release
 * orchestration keeps its own transport-retry wrappers). */

/** Captures the trimmed stdout of a git command pinned to repositoryRoot. */
export function runGitCapture(repositoryRoot, args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`, ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  ).trim();
}

/** HEAD commit time as a Unix-timestamp string (SOURCE_DATE_EPOCH source). */
export function readHeadCommitTimestamp(repositoryRoot) {
  return runGitCapture(repositoryRoot, ["show", "-s", "--format=%ct", "HEAD"]);
}

/** HEAD commit id, or null when the checkout cannot identify one. */
export function readRepositoryCommit(repositoryRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}
