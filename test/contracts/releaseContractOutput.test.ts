import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("release contract step output", () => {
  const repositoryRoot = process.cwd();
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-res-release-output-"));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("writes only key-value records when Git tag verification is enabled", function () {
    this.timeout(10_000);

    const scriptsDirectory = path.join(temporaryRoot, "scripts");
    fs.mkdirSync(scriptsDirectory, { recursive: true });
    for (const script of ["release-contract.mjs", "release-targets.mjs"]) {
      fs.copyFileSync(
        path.join(repositoryRoot, "scripts", script),
        path.join(scriptsDirectory, script)
      );
    }

    const manifest = {
      name: "release-output-fixture",
      version: "1.2.3",
      publisher: "fixture"
    };
    fs.writeFileSync(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    runGit(["init", "--quiet"]);
    runGit(["add", "package.json", "scripts/release-contract.mjs", "scripts/release-targets.mjs"]);
    runGit([
      "-c", "user.name=Release Contract Test",
      "-c", "user.email=release-contract@example.invalid",
      "commit", "--quiet", "-m", "test fixture"
    ]);
    runGit([
      "-c", "user.name=Release Contract Test",
      "-c", "user.email=release-contract@example.invalid",
      "tag", "-a", "v1.2.3", "-m", "v1.2.3"
    ]);

    const githubOutput = path.join(temporaryRoot, "github-output.txt");
    fs.writeFileSync(githubOutput, "preexisting=value\n", "utf8");
    const stdout = execFileSync(
      process.execPath,
      [
        path.join(scriptsDirectory, "release-contract.mjs"),
        "describe",
        "--tag", "v1.2.3",
        "--verify-git",
        "--output", githubOutput
      ],
      { cwd: temporaryRoot, encoding: "utf8" }
    );

    assert.strictEqual(stdout, "");
    const records = fs.readFileSync(githubOutput, "utf8").trim().split(/\r?\n/);
    assert.strictEqual(records[0], "preexisting=value");
    assert.ok(records.length > 0);
    for (const record of records) {
      assert.match(record, /^[A-Za-z_][A-Za-z0-9_]*=.*$/);
      assert.strictEqual(record.includes("refs/tags/"), false);
    }
    assert.strictEqual(
      outputValue(records, "commit"),
      runGit(["rev-parse", "HEAD"], "pipe").trim()
    );
  });

  it("passes the Actions output file explicitly instead of redirecting process logs", () => {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, ".github", "workflows", "release.yml"),
      "utf8"
    );
    const command = workflow.split(/\r?\n/).find(line =>
      line.includes("release-contract.mjs describe")
    );

    assert.ok(command);
    assert.ok(command.includes('--output "${GITHUB_OUTPUT}"'));
    assert.strictEqual(command.includes(">>"), false);
  });

  function runGit(args: string[], stdout: "ignore" | "pipe" = "ignore"): string {
    return execFileSync("git", args, {
      cwd: temporaryRoot,
      encoding: "utf8",
      stdio: ["ignore", stdout, "pipe"]
    }) ?? "";
  }
});

function outputValue(records: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  return records.find(record => record.startsWith(prefix))?.slice(prefix.length);
}
