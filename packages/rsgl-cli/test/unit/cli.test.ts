import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRsglCliArgs, runRsglCli, type RsglCliIo } from "../../src/cli";

interface CapturedIo {
  io: RsglCliIo;
  stdout(): string;
  stderr(): string;
}

function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: text => { out.push(text); },
      writeErr: text => { err.push(text); }
    },
    stdout: () => out.join(""),
    stderr: () => err.join("")
  };
}

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-cli-"));
}

const minimalModel = [
  "namespace minecraft",
  "model block stone {",
  "  parent minecraft:block/cube_all",
  "  textures { all: minecraft:block/stone }",
  "}"
].join("\n");

describe("RSGL CLI", () => {
  it("rejects unknown commands with exit code 2 and prints usage", () => {
    const captured = captureIo();
    const exitCode = runRsglCli(["frobnicate"], captured.io);

    assert.strictEqual(exitCode, 2);
    assert.ok(captured.stderr().includes("Unknown RSGL command: frobnicate"));
    assert.ok(captured.stdout().includes("Usage: rsgl <command>"));
  });

  it("prints usage and exits cleanly for the help command", () => {
    const captured = captureIo();
    const exitCode = runRsglCli(["help"], captured.io);

    assert.strictEqual(exitCode, 0);
    assert.ok(captured.stdout().includes("Usage: rsgl <command>"));
    assert.strictEqual(captured.stderr(), "");
  });

  it("builds a directory of RSGL sources and writes the emitted files", () => {
    const root = createTempRoot();
    const sourceRoot = path.join(root, "src");
    const outDir = path.join(root, "pack");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), minimalModel);

      const captured = captureIo();
      const exitCode = runRsglCli(["build", sourceRoot, "--out", outDir], captured.io);

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(
        fs.existsSync(path.join(outDir, "assets", "minecraft", "models", "block", "stone.json")),
        true
      );
      assert.ok(captured.stdout().includes("RSGL build complete"));
      assert.ok(!captured.stderr().includes(" error "));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews a build without writing any output files", () => {
    const root = createTempRoot();
    const sourceRoot = path.join(root, "src");
    const outDir = path.join(root, "pack");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), minimalModel);

      const captured = captureIo();
      const exitCode = runRsglCli(["build", sourceRoot, "--preview", "--out", outDir], captured.io);

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(fs.existsSync(outDir), false);
      assert.ok(captured.stdout().includes("# RSGL Build Preview"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints diagnostics to stderr and exits with 1 when compilation fails", () => {
    const root = createTempRoot();
    const sourceRoot = path.join(root, "src");
    const outDir = path.join(root, "pack");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "main.rsgl"), "use missingTemplate()");

      const captured = captureIo();
      const exitCode = runRsglCli(["build", sourceRoot, "--out", outDir], captured.io);

      assert.strictEqual(exitCode, 1);
      assert.ok(captured.stderr().includes("rsgl.undefinedSymbol"));
      assert.strictEqual(fs.existsSync(outDir), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing rsgl.config.json as defaults", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "main.rsgl"), minimalModel);
      process.chdir(root);

      const captured = captureIo();
      const exitCode = runRsglCli(["check"], captured.io);

      assert.strictEqual(exitCode, 0);
      assert.ok(!captured.stderr().includes(" error "));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a descriptive error when rsgl.config.json is not valid JSON", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "main.rsgl"), minimalModel);
      fs.writeFileSync(path.join(root, "rsgl.config.json"), "{ not json");
      process.chdir(root);

      const captured = captureIo();
      assert.throws(() => runRsglCli(["check"], captured.io), /Failed to read .*rsgl\.config\.json/);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes the --watch flag and positional arguments when parsing", () => {
    assert.deepStrictEqual(parseRsglCliArgs(["build", "src", "--out", "dist", "--preview"]), {
      command: "build",
      root: "src",
      outDir: "dist",
      preview: true
    });
    assert.strictEqual(parseRsglCliArgs(["build", "--watch"]).watch, true);
    assert.strictEqual(parseRsglCliArgs([]).command, "help");
  });
});
