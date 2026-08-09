import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../helpers/testProcess";

describe("release dry-run orchestration", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("performs Git and remote preflight without changing files, commits, or tags", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-release-dry-run-"));
    const repository = path.join(temporaryRoot, "work tree 空格");
    const remote = path.join(temporaryRoot, "origin bare.git");
    fs.mkdirSync(repository, { recursive: true });
    try {
      runGit(temporaryRoot, ["init", "--bare", remote]);
      runGit(repository, ["init", "--initial-branch=main"]);
      runGit(repository, ["config", "user.name", "Release Contract"]);
      runGit(repository, ["config", "user.email", "release-contract@example.invalid"]);
      writeJson(repository, "packages/rsgl-cli/package.json", {
        name: "@fixture/rsgl-cli",
        version: "1.0.0"
      });
      write(repository, "packages/rsgl-cli/CHANGELOG.md", [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "- dry-run fixture",
        ""
      ].join("\n"));
      runGit(repository, ["add", "."]);
      runGit(repository, ["commit", "-m", "chore: fixture"]);
      runGit(repository, ["remote", "add", "origin", remote]);
      runGit(repository, ["push", "-u", "origin", "main"]);

      const initialCommit = gitOutput(repository, ["rev-parse", "HEAD"]);
      const initialManifest = fs.readFileSync(path.join(
        repository,
        "packages",
        "rsgl-cli",
        "package.json"
      ));
      const releaseScript = path.join(process.cwd(), "scripts", "release.mjs");
      const result = runTestProcessSync(process.execPath, [
        releaseScript,
        "rsgl-cli",
        "patch",
        "--dry-run"
      ], { cwd: repository });

      assertTestProcessStatus(result, 0, "release dry-run failed");
      assert.match(result.stdout, /Version: 1\.0\.0 -> 1\.0\.1/);
      assert.match(result.stdout, /Dry run complete\. No files were changed\./);
      assert.strictEqual(gitOutput(repository, ["rev-parse", "HEAD"]), initialCommit);
      assert.strictEqual(gitOutput(repository, ["status", "--porcelain"]), "");
      assert.strictEqual(gitOutput(repository, ["tag", "--list"]), "");
      assert.deepStrictEqual(fs.readFileSync(path.join(
        repository,
        "packages",
        "rsgl-cli",
        "package.json"
      )), initialManifest);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function runGit(cwd: string, args: string[]): void {
  const result = runTestProcessSync("git", args, { cwd });
  assertTestProcessStatus(result, 0, `git ${args.join(" ")} failed`);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = runTestProcessSync("git", args, { cwd });
  assertTestProcessStatus(result, 0, `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function write(root: string, relativePath: string, content: string): void {
  const fileName = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, content, "utf8");
}
