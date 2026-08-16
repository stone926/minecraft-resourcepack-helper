import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

describe("VS Code test runtime preparation", () => {
  const repositoryRoot = process.cwd();
  let runtime: RuntimePreparationModule;

  before(async () => {
    runtime = await import(pathToFileURL(path.join(
      repositoryRoot,
      "scripts",
      "prepare-vscode-test-runtime.mjs"
    )).href) as RuntimePreparationModule;
  });

  it("downloads the root engine minimum into runner temp and safely exports its executable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mrph-vscode-runtime-contract-"));
    try {
      const runnerTemp = path.join(root, "runner temp");
      const githubEnvironmentFile = path.join(root, "github-env");
      const manifest = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, "package.json"),
        "utf8"
      )) as { engines: { vscode: string } };
      fs.mkdirSync(runnerTemp, { recursive: true });
      fs.writeFileSync(githubEnvironmentFile, "EXISTING=value\n", "utf8");

      let downloadOptions: DownloadOptions | undefined;
      const result = await runtime.prepareVscodeTestRuntime({
        repositoryRoot,
        environment: {
          GITHUB_ENV: githubEnvironmentFile,
          RUNNER_TEMP: runnerTemp
        },
        downloadRuntime: async options => {
          downloadOptions = options;
          const executablePath = path.join(options.cachePath, "vscode-linux-x64", "code");
          fs.mkdirSync(path.dirname(executablePath), { recursive: true });
          fs.writeFileSync(executablePath, "runtime", "utf8");
          return executablePath;
        }
      });

      const expectedVersion = manifest.engines.vscode.slice(1);
      const expectedCache = path.join(runnerTemp, "minecraft-resourcepack-helper-vscode-test");
      assert.deepStrictEqual(downloadOptions, {
        version: expectedVersion,
        cachePath: expectedCache
      });
      assert.strictEqual(result.version, expectedVersion);
      assert.strictEqual(result.cachePath, expectedCache);
      assert.strictEqual(
        fs.readFileSync(githubEnvironmentFile, "utf8"),
        `EXISTING=value\nVSCODE_EXECUTABLE_PATH=${result.executablePath}\n`
      );
      assert.throws(
        () => runtime.appendGitHubEnvironmentVariable(
          githubEnvironmentFile,
          "VSCODE_EXECUTABLE_PATH",
          "safe\nINJECTED=value"
        ),
        /single-line value/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

interface DownloadOptions {
  version: string;
  cachePath: string;
}

interface RuntimePreparationModule {
  prepareVscodeTestRuntime(options: {
    repositoryRoot: string;
    environment: Record<string, string | undefined>;
    downloadRuntime(options: DownloadOptions): Promise<string>;
  }): Promise<DownloadOptions & { executablePath: string }>;
  appendGitHubEnvironmentVariable(fileName: string, name: string, value: string): void;
}
