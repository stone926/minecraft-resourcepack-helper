import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface NpmInvocationModule {
  resolveNpmInvocation(args: string[], options?: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
  }): { file: string; args: string[] };
  npmEnvironmentWithCache(
    cacheDirectory: string,
    environment?: NodeJS.ProcessEnv
  ): NodeJS.ProcessEnv;
}

describe("npm process invocation", () => {
  let npmInvocation: NpmInvocationModule;
  let temporaryRoot: string;

  before(async () => {
    const moduleUrl = pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "npm-invocation.mjs"
    )).href;
    npmInvocation = await import(moduleUrl) as NpmInvocationModule;
  });

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-cli-package-contract-"));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("launches npm's JavaScript entry point directly on Windows", () => {
    const invocation = npmInvocation.resolveNpmInvocation(
      ["pack", "--pack-destination", "C:\\Temp\\package output"],
      {
        platform: "win32",
        nodeExecutable: "C:\\node\\node.exe",
        environment: {
          npm_execpath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js"
        }
      }
    );

    assert.deepStrictEqual(invocation, {
      file: "C:\\node\\node.exe",
      args: [
        "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
        "pack",
        "--pack-destination",
        "C:\\Temp\\package output"
      ]
    });
  });

  it("uses a disposable cache without retaining inherited cache aliases", () => {
    const cacheDirectory = path.join(process.cwd(), "temporary npm cache");
    const environment = npmInvocation.npmEnvironmentWithCache(cacheDirectory, {
      PATH: "test-path",
      NPM_CONFIG_CACHE: "C:\\stale-cache",
      npm_config_cache: "C:\\other-stale-cache"
    });

    assert.strictEqual(environment.PATH, "test-path");
    assert.strictEqual(environment.NPM_CONFIG_CACHE, undefined);
    assert.strictEqual(environment.npm_config_cache, path.resolve(cacheDirectory));
    assert.deepStrictEqual(
      Object.keys(environment).filter(name => name.toLowerCase() === "npm_config_cache"),
      ["npm_config_cache"]
    );
  });

  it("falls back to cmd.exe only when npm did not provide its CLI entry", () => {
    const invocation = npmInvocation.resolveNpmInvocation(
      ["install", "C:\\an archive\\cli.tgz"],
      {
        platform: "win32",
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
      }
    );

    assert.strictEqual(invocation.file, "C:\\Windows\\System32\\cmd.exe");
    assert.deepStrictEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(invocation.args[3], /"C:\\an archive\\cli\.tgz"/);
  });

  it("packages through a foreground npm process with an isolated cache", () => {
    const fakeNpmDirectory = path.join(temporaryRoot, "npm tool", "bin");
    const fakeNpmCli = path.join(fakeNpmDirectory, "npm-cli.js");
    const recordPath = path.join(temporaryRoot, "npm-invocation.json");
    const outputPath = path.join(temporaryRoot, "nested output", "rsgl-cli.tgz");
    fs.mkdirSync(fakeNpmDirectory, { recursive: true });
    fs.writeFileSync(fakeNpmCli, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const destinationIndex = args.indexOf('--pack-destination');",
      "if (destinationIndex < 0) process.exit(2);",
      "const destination = args[destinationIndex + 1];",
      "fs.mkdirSync(destination, { recursive: true });",
      "fs.writeFileSync(path.join(destination, 'fixture-rsgl-cli.tgz'), 'archive fixture');",
      "fs.writeFileSync(process.env.RSGL_CLI_NPM_RECORD, JSON.stringify({",
      "  args,",
      "  cache: process.env.npm_config_cache",
      "}));"
    ].join("\n"), "utf8");

    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name.toLowerCase() !== "npm_config_cache"));
    environment.npm_execpath = fakeNpmCli;
    environment.npm_config_cache = path.join(temporaryRoot, "inherited stale cache");
    environment.RSGL_CLI_NPM_RECORD = recordPath;

    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "package-rsgl-cli.mjs"),
        "--out",
        outputPath
      ],
      { cwd: process.cwd(), env: environment, stdio: "pipe" }
    );

    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      args: string[];
      cache: string;
    };
    assert.strictEqual(fs.readFileSync(outputPath, "utf8"), "archive fixture");
    assert.strictEqual(record.args[0], "pack");
    assert.ok(record.args.includes("--foreground-scripts"));
    assert.ok(!record.args.includes("--silent"));
    assert.notStrictEqual(record.cache, environment.npm_config_cache);
    assert.strictEqual(path.basename(record.cache), "npm-cache");
    assert.ok(!fs.existsSync(record.cache), "temporary npm cache should be removed after packaging");
  });
});
