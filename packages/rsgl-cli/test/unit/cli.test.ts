import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createCliContext,
  isRsglWatchPathRelevant,
  nearestExistingWatchDirectory,
  parseRsglCliArgs,
  runRsglCli,
  startRsglCliWatch,
  type RsglCliWatchRuntime,
  type RsglCliIo
} from "../../src/cli";
import { parseRsglProjectConfig } from "../../../rsgl-core/src/rsglConfig";

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
  "extern! vanilla model minecraft:block/cube_all",
  "extern! vanilla texture minecraft:block/stone",
  "model block stone {",
  "  parent minecraft:block/cube_all",
  "  textures { all: minecraft:block/stone }",
  "}"
].join("\n");

interface FakeDirectoryWatcher {
  directory: string;
  recursive: boolean;
  closed: boolean;
  listener: (eventType: string, fileName: string | Buffer | null) => void;
}

interface FakeWatchRuntime {
  runtime: RsglCliWatchRuntime;
  builds: Array<{
    root: string;
    options: Parameters<RsglCliWatchRuntime["build"]>[1];
  }>;
  configListeners: Map<string, () => void>;
  directoryWatchers: FakeDirectoryWatcher[];
  flushTimers(): void;
  triggerConfig(fileName: string): void;
}

function createFakeWatchRuntime(): FakeWatchRuntime {
  const builds: FakeWatchRuntime["builds"] = [];
  const configListeners = new Map<string, () => void>();
  const directoryWatchers: FakeDirectoryWatcher[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const runtime: RsglCliWatchRuntime = {
    build: (root, options) => {
      builds.push({ root, options });
      return { diagnostics: [], dependencies: [] };
    },
    watchDirectory: (directory, recursive, listener) => {
      const watcher: FakeDirectoryWatcher = { directory, recursive, listener, closed: false };
      directoryWatchers.push(watcher);
      return { close: () => { watcher.closed = true; } };
    },
    watchConfigFile: (fileName, listener) => {
      const key = normalizedTestPath(fileName);
      configListeners.set(key, listener);
      return {
        close: () => {
          if (configListeners.get(key) === listener) {
            configListeners.delete(key);
          }
        }
      };
    },
    setTimer: listener => {
      const timer = nextTimer++;
      timers.set(timer, listener);
      return timer;
    },
    clearTimer: handle => {
      if (typeof handle === "number") {
        timers.delete(handle);
      }
    }
  };
  return {
    runtime,
    builds,
    configListeners,
    directoryWatchers,
    flushTimers: () => {
      while (timers.size > 0) {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(listener => listener());
      }
    },
    triggerConfig: fileName => {
      const listener = configListeners.get(normalizedTestPath(fileName));
      assert.ok(listener, `Expected a config watcher for ${fileName}`);
      listener();
    }
  };
}

function normalizedTestPath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

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
    const output = captured.stdout();

    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes("Usage: rsgl <command> [root|file] [options]"));
    assert.ok(output.includes("--out <dir>, --outDir <dir>"));
    assert.ok(output.includes("for build, check, and watch"));
    assert.ok(output.includes("--preview"));
    assert.ok(output.includes("(build only)"));
    assert.ok(output.includes("--watch"));
    assert.ok(output.includes("equivalent to watch"));
    assert.strictEqual(captured.stderr(), "");
  });

  it("initializes a public project config without exposing internal compiler keys", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const captured = captureIo();

      assert.strictEqual(runRsglCli(["init"], captured.io), 0);
      const config = JSON.parse(fs.readFileSync(path.join(root, "rsgl.config.json"), "utf8"));
      assert.strictEqual(config.namespace, "minecraft");
      assert.strictEqual(config.maxEvaluationItems, 100000);
      assert.strictEqual(config.maxItemModelDepth, 128);
      assert.strictEqual("defaultNamespace" in config, false);
      assert.strictEqual("projectTarget" in config, false);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("passes validated global extern declarations into build options", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    const extern = [{
      source: "vanilla" as const,
      kind: "texture" as const,
      patterns: ["minecraft:block/*", "*:item/**"],
      checkExistence: false
    }];
    try {
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({ extern }));
      process.chdir(root);

      const context = createCliContext({ command: "check" });

      assert.deepStrictEqual(context.options.globalExterns, extern);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the global extern existence switch into build options", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    try {
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        checkExternExistence: false
      }));
      process.chdir(root);

      const context = createCliContext({ command: "check" });

      assert.strictEqual(context.options.checkExternExistence, false);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps public namespace, target, and compile limits to compiler options", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    try {
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        namespace: "project_ns",
        target: { edition: "java", mc: "1.21.11" },
        maxEvaluationItems: 54321,
        maxItemModelDepth: 96
      }));
      process.chdir(root);

      const context = createCliContext({ command: "check" });

      assert.strictEqual(context.options.namespace, undefined, "project namespace must not become a hard override");
      assert.strictEqual(context.options.defaultNamespace, "project_ns");
      assert.deepStrictEqual(context.options.projectTarget, {
        edition: "java",
        packFormat: { major: 75, minor: 0 }
      });
      assert.strictEqual(context.options.maxEvaluationItems, 54321);
      assert.strictEqual(context.options.maxItemModelDepth, 96);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the nearest config for an explicit source root and resolves its resource paths", () => {
    const root = createTempRoot();
    const projectRoot = path.join(root, "nested project");
    const sourceRoot = path.join(projectRoot, "sources");
    const defaultAssets = path.join(root, "vanilla assets 原版");
    const customPack = path.join(root, "custom packs", "资源 包");
    const vanillaTexture = path.join(defaultAssets, "assets", "example", "textures", "item", "vanilla.png");
    const customTexture = path.join(customPack, "assets", "example", "textures", "item", "custom.png");
    try {
      for (const directory of [sourceRoot, path.dirname(vanillaTexture), path.dirname(customTexture)]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(vanillaTexture, Buffer.alloc(0));
      fs.writeFileSync(customTexture, Buffer.alloc(0));
      fs.writeFileSync(path.join(customPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({ unexpected: true }));
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), JSON.stringify({
        outDir: "generated pack",
        defaultAssetsPath: path.relative(projectRoot, defaultAssets),
        resourcePackRoots: [path.relative(projectRoot, customPack)],
        checkExternExistence: false
      }));

      const context = createCliContext({ command: "check", root: sourceRoot });

      assert.strictEqual(context.configFileName, path.join(projectRoot, "rsgl.config.json"));
      assert.strictEqual(context.root, sourceRoot);
      assert.strictEqual(context.options.outputRoot, path.join(projectRoot, "generated pack"));
      assert.strictEqual(context.options.checkExternExistence, false);
      assert.strictEqual(context.options.externResourceExists?.("vanilla", "texture", "example:item/vanilla"), true);
      assert.strictEqual(context.options.externResourceExists?.("custom", "texture", "example:item/custom"), true);
      assert.strictEqual(context.options.externResourceExists?.("custom", "texture", "example:item/vanilla"), false);
      assert.strictEqual(context.configSearchRoot, sourceRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves config root and output paths relative to the config file without an explicit root", () => {
    const root = createTempRoot();
    const previousCwd = process.cwd();
    const sourceRoot = path.join(root, "RSGL sources 源");
    const outputRoot = path.join(root, "generated pack 输出");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        root: path.relative(root, sourceRoot),
        outDir: path.relative(root, outputRoot)
      }));
      process.chdir(root);

      const context = createCliContext({ command: "check" });

      assert.strictEqual(context.root, sourceRoot);
      assert.strictEqual(context.options.outputRoot, outputRoot);
      assert.strictEqual(context.configSearchRoot, path.join(root, "src"));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid extern config entries with exact field paths", () => {
    const invalidConfigs: readonly [unknown, RegExp][] = [
      [{ extern: {} }, /rsgl\.config\.json\.extern: expected an array/],
      [{ extern: [null] }, /rsgl\.config\.json\.extern\[0\]: expected an object/],
      [{ extern: [{ source: "builtin", kind: "texture", patterns: ["minecraft:block/**"] }] },
        /rsgl\.config\.json\.extern\[0\]\.source/],
      [{ extern: [{ source: "vanilla", kind: "particle", patterns: ["minecraft:block/**"] }] },
        /rsgl\.config\.json\.extern\[0\]\.kind/],
      [{ extern: [{ source: "vanilla", kind: "texture", patterns: ["minecraft:block/wood*"] }] },
        /rsgl\.config\.json\.extern\[0\]\.patterns\[0\]/],
      [{ extern: [{ source: "vanilla", kind: "texture", patterns: [] }] },
        /rsgl\.config\.json\.extern\[0\]\.patterns/],
      [{ extern: [{ source: "vanilla", kind: "texture", patterns: ["minecraft:block/**"], checkExistence: "no" }] },
        /rsgl\.config\.json\.extern\[0\]\.checkExistence/],
      [{ checkExternExistence: 0 }, /rsgl\.config\.json\.checkExternExistence/]
    ];

    for (const [config, expectedMessage] of invalidConfigs) {
      assert.throws(() => parseRsglProjectConfig(config), expectedMessage);
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

  it("filters watch events to RSGL sources and known JSON dependencies", () => {
    const root = path.join(os.tmpdir(), "rsgl-watch-filter");
    const baseFile = path.join(root, "fragments", "base.json");
    const dependencies = [{
      path: baseFile,
      reason: "base-import" as const,
      sourceFile: path.join(root, "main.rsgl"),
      sourceRange: { start: 0, end: 18 }
    }];

    assert.strictEqual(
      isRsglWatchPathRelevant(path.join(root, "nested", "model.RSGL"), dependencies),
      true
    );
    assert.strictEqual(
      isRsglWatchPathRelevant(path.join(root, "fragments", ".", "base.json"), dependencies),
      true
    );
    assert.strictEqual(
      isRsglWatchPathRelevant(path.join(root, "fragments", "unrelated.json"), dependencies),
      false
    );
  });

  it("reloads created, edited, and deleted nearest configs and rewires the source watcher", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const defaultSourceRoot = path.join(workspaceRoot, "src");
    const outerSourceRoot = path.join(root, "outer source");
    const nearSourceRoot = path.join(workspaceRoot, "near source");
    const editedSourceRoot = path.join(workspaceRoot, "edited source");
    const outerConfig = path.join(root, "rsgl.config.json");
    const nearConfig = path.join(workspaceRoot, "rsgl.config.json");
    const previousCwd = process.cwd();
    const fake = createFakeWatchRuntime();
    const captured = captureIo();
    let session: ReturnType<typeof startRsglCliWatch> | undefined;
    try {
      for (const directory of [defaultSourceRoot, outerSourceRoot, nearSourceRoot, editedSourceRoot]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(outerConfig, JSON.stringify({
        root: "outer source",
        outDir: "outer output",
        namespace: "outer_ns",
        target: { edition: "java", format: [75, 0] },
        maxEvaluationItems: 1000
      }));
      process.chdir(workspaceRoot);

      session = startRsglCliWatch({ command: "watch" }, captured.io, fake.runtime);

      assert.strictEqual(fake.builds.length, 1);
      assert.strictEqual(fake.builds[0].root, outerSourceRoot);
      assert.strictEqual(session.currentContext().configFileName, outerConfig);
      assert.strictEqual(fake.builds[0].options.defaultNamespace, "outer_ns");
      assert.strictEqual(fake.builds[0].options.projectTarget?.packFormat.major, 75);
      assert.strictEqual(fake.builds[0].options.maxEvaluationItems, 1000);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [outerSourceRoot]);

      fs.writeFileSync(nearConfig, JSON.stringify({
        root: "near source",
        outDir: "near output",
        namespace: "near_ns",
        target: { edition: "java", format: [74, 0] },
        maxEvaluationItems: 2000
      }));
      fake.triggerConfig(nearConfig);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 2);
      assert.strictEqual(fake.builds[1].root, nearSourceRoot);
      assert.strictEqual(fake.builds[1].options.outputRoot, path.join(workspaceRoot, "near output"));
      assert.strictEqual(fake.builds[1].options.defaultNamespace, "near_ns");
      assert.strictEqual(fake.builds[1].options.projectTarget?.packFormat.major, 74);
      assert.strictEqual(fake.builds[1].options.maxEvaluationItems, 2000);
      assert.strictEqual(session.currentContext().configFileName, nearConfig);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [nearSourceRoot]);

      fs.writeFileSync(nearConfig, JSON.stringify({
        root: "edited source",
        outDir: "edited output",
        namespace: "edited_ns",
        target: { edition: "java", format: [75, 0] },
        maxEvaluationItems: 3000
      }));
      fake.triggerConfig(nearConfig);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 3);
      assert.strictEqual(fake.builds[2].root, editedSourceRoot);
      assert.strictEqual(fake.builds[2].options.outputRoot, path.join(workspaceRoot, "edited output"));
      assert.strictEqual(fake.builds[2].options.defaultNamespace, "edited_ns");
      assert.strictEqual(fake.builds[2].options.projectTarget?.packFormat.major, 75);
      assert.strictEqual(fake.builds[2].options.maxEvaluationItems, 3000);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [editedSourceRoot]);

      const editedSourceWatcher = fake.directoryWatchers.find(watcher => !watcher.closed);
      assert.ok(editedSourceWatcher);
      editedSourceWatcher.listener("change", "main.rsgl");
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 4);
      assert.strictEqual(fake.builds[3].root, editedSourceRoot);

      fs.rmSync(nearConfig);
      fake.triggerConfig(nearConfig);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 5);
      assert.strictEqual(fake.builds[4].root, outerSourceRoot);
      assert.strictEqual(fake.builds[4].options.defaultNamespace, "outer_ns");
      assert.strictEqual(session.currentContext().configFileName, outerConfig);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [outerSourceRoot]);
    } finally {
      session?.close();
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }

    assert.ok(fake.directoryWatchers.every(watcher => watcher.closed));
    assert.strictEqual(fake.configListeners.size, 0);
  });

  it("watches an invalid parent config exposed by deleting the nearest config", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    const parentSourceRoot = path.join(root, "parent source");
    const parentConfig = path.join(root, "rsgl.config.json");
    const nearConfig = path.join(workspaceRoot, "rsgl.config.json");
    const previousCwd = process.cwd();
    const fake = createFakeWatchRuntime();
    const captured = captureIo();
    let session: ReturnType<typeof startRsglCliWatch> | undefined;
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.mkdirSync(parentSourceRoot, { recursive: true });
      fs.writeFileSync(parentConfig, "{");
      fs.writeFileSync(nearConfig, JSON.stringify({ root: "source" }));
      process.chdir(workspaceRoot);

      session = startRsglCliWatch({ command: "watch" }, captured.io, fake.runtime);
      assert.strictEqual(fake.builds.length, 1);

      fs.rmSync(nearConfig);
      fake.triggerConfig(nearConfig);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 1);
      assert.ok(captured.stderr().includes(parentConfig));
      assert.ok(fake.configListeners.has(normalizedTestPath(parentConfig)));

      fs.writeFileSync(parentConfig, JSON.stringify({ root: "parent source" }));
      fake.triggerConfig(parentConfig);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 2);
      assert.strictEqual(fake.builds[1].root, parentSourceRoot);
      assert.strictEqual(session.currentContext().configFileName, parentConfig);
    } finally {
      session?.close();
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers when the nearest config is already invalid at watch startup", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    const config = path.join(workspaceRoot, "rsgl.config.json");
    const previousCwd = process.cwd();
    const fake = createFakeWatchRuntime();
    const captured = captureIo();
    let session: ReturnType<typeof startRsglCliWatch> | undefined;
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(config, "{");
      process.chdir(workspaceRoot);

      session = startRsglCliWatch({ command: "watch" }, captured.io, fake.runtime);

      assert.strictEqual(fake.builds.length, 0);
      assert.ok(captured.stderr().includes(config));
      assert.ok(fake.configListeners.has(normalizedTestPath(config)));

      fs.writeFileSync(config, JSON.stringify({ root: "source" }));
      fake.triggerConfig(config);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 1);
      assert.strictEqual(fake.builds[0].root, sourceRoot);
      assert.strictEqual(session.currentContext().configFileName, config);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [sourceRoot]);
    } finally {
      session?.close();
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the old source watcher until a newly configured root becomes watchable", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const initialSourceRoot = path.join(workspaceRoot, "initial source");
    const missingSourceRoot = path.join(workspaceRoot, "missing source");
    const config = path.join(workspaceRoot, "rsgl.config.json");
    const previousCwd = process.cwd();
    const fake = createFakeWatchRuntime();
    const watchDirectory = fake.runtime.watchDirectory;
    const captured = captureIo();
    let rejectMissingRoot = true;
    let session: ReturnType<typeof startRsglCliWatch> | undefined;
    fake.runtime.watchDirectory = (directory, recursive, listener) => {
      if (rejectMissingRoot && path.resolve(directory) === path.resolve(missingSourceRoot)) {
        throw new Error(`Cannot watch ${directory}`);
      }
      return watchDirectory(directory, recursive, listener);
    };
    try {
      fs.mkdirSync(initialSourceRoot, { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ root: "initial source" }));
      process.chdir(workspaceRoot);

      session = startRsglCliWatch({ command: "watch" }, captured.io, fake.runtime);
      fs.writeFileSync(config, JSON.stringify({ root: "missing source" }));
      fake.triggerConfig(config);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 1);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [initialSourceRoot]);
      assert.ok(fake.configListeners.has(normalizedTestPath(missingSourceRoot)));
      assert.strictEqual(session.currentContext().root, initialSourceRoot);

      rejectMissingRoot = false;
      fs.mkdirSync(missingSourceRoot, { recursive: true });
      fake.triggerConfig(missingSourceRoot);
      fake.flushTimers();

      assert.strictEqual(fake.builds.length, 2);
      assert.strictEqual(fake.builds[1].root, missingSourceRoot);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [missingSourceRoot]);
      assert.strictEqual(fake.configListeners.has(normalizedTestPath(missingSourceRoot)), false);
    } finally {
      session?.close();
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a pending root watcher when configuration returns to the active root", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const activeSourceRoot = path.join(workspaceRoot, "active source");
    const missingSourceRoot = path.join(workspaceRoot, "missing source");
    const config = path.join(workspaceRoot, "rsgl.config.json");
    const previousCwd = process.cwd();
    const fake = createFakeWatchRuntime();
    const watchDirectory = fake.runtime.watchDirectory;
    const captured = captureIo();
    let session: ReturnType<typeof startRsglCliWatch> | undefined;
    fake.runtime.watchDirectory = (directory, recursive, listener) => {
      if (path.resolve(directory) === path.resolve(missingSourceRoot)) {
        throw new Error(`Cannot watch ${directory}`);
      }
      return watchDirectory(directory, recursive, listener);
    };
    try {
      fs.mkdirSync(activeSourceRoot, { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ root: "active source" }));
      process.chdir(workspaceRoot);

      session = startRsglCliWatch({ command: "watch" }, captured.io, fake.runtime);
      fs.writeFileSync(config, JSON.stringify({ root: "missing source" }));
      fake.triggerConfig(config);
      fake.flushTimers();
      assert.ok(fake.configListeners.has(normalizedTestPath(missingSourceRoot)));

      fs.writeFileSync(config, JSON.stringify({ root: "active source" }));
      fake.triggerConfig(config);
      fake.flushTimers();

      assert.strictEqual(fake.configListeners.has(normalizedTestPath(missingSourceRoot)), false);
      assert.deepStrictEqual(activeSourceWatchDirectories(fake), [activeSourceRoot]);
      assert.strictEqual(fake.builds.length, 2);
    } finally {
      session?.close();
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the closest existing ancestor for missing external dependency directories", () => {
    const root = createTempRoot();
    try {
      const existing = path.join(root, "external");
      fs.mkdirSync(existing);
      assert.strictEqual(
        nearestExistingWatchDirectory(path.join(existing, "missing", "nested")),
        path.resolve(existing)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function activeSourceWatchDirectories(fake: FakeWatchRuntime): string[] {
  return fake.directoryWatchers
    .filter(watcher => watcher.recursive && !watcher.closed)
    .map(watcher => watcher.directory);
}
