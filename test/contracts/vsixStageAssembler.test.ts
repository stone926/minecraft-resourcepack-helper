import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_DATE_EPOCH = "1700000000";

interface StageFile {
  path: string;
  content: string | Buffer | Uint8Array;
}

interface StageResult {
  stageRoot: string;
  contentsManifestFile: string;
  contentHash: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  written: readonly string[];
  reused: readonly string[];
  removed: readonly string[];
  manifestWritten: boolean;
}

interface StageTreeModule {
  assembleVsixStageTree(options: {
    stageRoot: string;
    allowedStageParent: string;
    contentsManifestFile: string;
    sourceDateEpoch: string | number;
    files: StageFile[];
    allowedForbiddenPaths?: string[];
  }): StageResult;
}

interface MainStageModule {
  mainVsixRuntimeBundles: readonly string[];
  mainVsixRuntimeSourceMaps: readonly string[];
  mainVsixGeneratedIgnore: readonly string[];
  mainVsixDevelopmentGeneratedIgnore: readonly string[];
  assembleMainVsixStage(options: {
    repositoryRoot: string;
    sourceDateEpoch: string | number;
    bundleMode?: "development" | "production";
  }): StageResult;
  parseMainVsixStageArguments(args: string[]): {
    sourceDateEpoch?: string;
    bundleMode: "development" | "production";
  };
  resolveMainVsixSourceDateEpoch(options: {
    repositoryRoot: string;
    environment?: Record<string, string | undefined>;
    readCommitTimestamp?: (repositoryRoot: string) => string;
  }): number;
}

describe("main VSIX stage assembler", () => {
  let temporaryRoots: string[] = [];
  let stageTree: StageTreeModule;
  let mainStage: MainStageModule;

  before(async () => {
    const root = process.cwd();
    stageTree = await import(pathToFileURL(path.join(root, "scripts", "vsix-stage-tree.mjs")).href) as StageTreeModule;
    mainStage = await import(pathToFileURL(path.join(root, "scripts", "assemble-main-vsix-stage.mjs")).href) as MainStageModule;
  });

  afterEach(() => {
    for (const root of temporaryRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots = [];
  });

  it("assembles the single-VSIX runtime allow-list and emits a verifiable contents hash", () => {
    const repositoryRoot = createFixtureRepository();
    const result = mainStage.assembleMainVsixStage({
      repositoryRoot,
      sourceDateEpoch: SOURCE_DATE_EPOCH
    });

    assert.deepStrictEqual(mainStage.mainVsixRuntimeBundles, [
      "bundle/extension.js",
      "bundle/features/rsglHost.js",
      "bundle/rsgl/server.js",
      "bundle/rsgl/worker.js",
      "bundle/model-preview.js"
    ]);
    assert.ok(mainStage.mainVsixGeneratedIgnore.includes("**/*.map"));
    assert.deepStrictEqual(listFiles(result.stageRoot), [
      ".vscodeignore",
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "README_CN.md",
      "assets/cit/builtin-resource-ids.json",
      "assets/cit/en/base.json",
      "assets/linters/en/schema.json",
      "assets/mcResHelperSidebar.svg",
      "bundle/extension.js",
      "bundle/features/rsglHost.js",
      "bundle/model-preview.js",
      "bundle/rsgl/server.js",
      "bundle/rsgl/stdlib/conventions/example.rsgl",
      "bundle/rsgl/worker.js",
      "icon.png",
      "l10n/bundle.l10n.json",
      "language-configuration/rsgl.json",
      "licenses/THREE-LICENSE.txt",
      "package.json",
      "package.nls.json",
      "schemas/en/rsgl-config.schema.json",
      "syntaxes/rsgl.tmLanguage.json",
      "webviews/modelPreview/styles.css"
    ]);

    const publishManifest = readJson<Record<string, unknown>>(path.join(result.stageRoot, "package.json"));
    assert.deepStrictEqual(publishManifest.scripts, { keep: "node keep.mjs" });
    assert.strictEqual(publishManifest.dependencies, undefined);
    assert.strictEqual(publishManifest.devDependencies, undefined);
    assert.strictEqual(
      fs.readFileSync(path.join(result.stageRoot, "assets", "linters", "en", "schema.json"), "utf8"),
      JSON.stringify({ title: "Schema", type: "object" })
    );
    assert.strictEqual(
      fs.readFileSync(path.join(result.stageRoot, "bundle", "rsgl", "stdlib", "conventions", "example.rsgl"), "utf8"),
      "// preserve source ranges\nresource demo\n"
    );
    assert.deepStrictEqual(
      readJson(path.join(result.stageRoot, "package.nls.json")),
      {
        "extension.displayName": "Main Fixture",
        "rsgl.command.build": "Build RSGL",
        "schema.rsglConfig.url": "./schemas/en/rsgl-config.schema.json",
        "schema.root.url": "./assets/linters/en/schema.json"
      }
    );
    assert.deepStrictEqual(
      readJson(path.join(result.stageRoot, "l10n", "bundle.l10n.json")),
      { "RSGL message": "RSGL message", "Root message": "Root message" }
    );

    for (const forbidden of [
      "bundle/extension.js.map",
      "bundle/model-preview.js.map",
      "webviews/modelPreview/main.js",
      "webviews/modelPreview/vendor/three.module.js",
      "node_modules/three/index.js",
      "src/extension.ts",
      "test/fixture.json",
      "assets/demo.gif"
    ]) {
      assert.strictEqual(fs.existsSync(path.join(result.stageRoot, ...forbidden.split("/"))), false, forbidden);
    }

    const contents = readJson<ContentsManifest>(result.contentsManifestFile);
    assert.strictEqual(contents.schemaVersion, 1);
    assert.strictEqual(contents.sourceDateEpoch, SOURCE_DATE_EPOCH);
    assert.deepStrictEqual(contents.files.map(file => file.path), listFiles(result.stageRoot));
    for (const file of contents.files) {
      const bytes = fs.readFileSync(path.join(result.stageRoot, ...file.path.split("/")));
      assert.strictEqual(file.bytes, bytes.length);
      assert.strictEqual(file.sha256, sha256(bytes));
    }
    assert.strictEqual(contents.contentHash, hashManifestEntries(contents.files));
    assert.strictEqual(result.contentHash, contents.contentHash);
    assert.strictEqual(result.written.length, contents.files.length);
    assertNormalizedMtimes(result.stageRoot, Number(SOURCE_DATE_EPOCH) * 1_000);
  });

  it("cleans stale files while reusing unchanged stage bytes", () => {
    const repositoryRoot = createFixtureRepository();
    const first = mainStage.assembleMainVsixStage({ repositoryRoot, sourceDateEpoch: SOURCE_DATE_EPOCH });
    const rootBundle = path.join(first.stageRoot, "bundle", "extension.js");
    const firstInode = fs.statSync(rootBundle).ino;
    const firstManifestBytes = fs.readFileSync(first.contentsManifestFile);

    writeFile(first.stageRoot, "bundle/leaked.js.map", "map");
    writeFile(first.stageRoot, "src/leaked.ts", "source");
    const second = mainStage.assembleMainVsixStage({ repositoryRoot, sourceDateEpoch: SOURCE_DATE_EPOCH });

    assert.deepStrictEqual(second.written, []);
    assert.strictEqual(second.reused.length, second.files.length);
    assert.ok(second.removed.includes("bundle/leaked.js.map"));
    assert.ok(second.removed.includes("src/leaked.ts"));
    assert.strictEqual(second.manifestWritten, false);
    assert.strictEqual(fs.statSync(rootBundle).ino, firstInode);
    assert.ok(fs.readFileSync(second.contentsManifestFile).equals(firstManifestBytes));

    writeFile(repositoryRoot, "README.md", "changed readme\n");
    const third = mainStage.assembleMainVsixStage({ repositoryRoot, sourceDateEpoch: SOURCE_DATE_EPOCH });
    assert.deepStrictEqual(third.written, ["README.md"]);
    assert.strictEqual(third.reused.length, third.files.length - 1);
    assert.notStrictEqual(third.contentHash, first.contentHash);
    assert.strictEqual(fs.statSync(rootBundle).ino, firstInode);
  });

  it("is reproducible across checkout paths and source mtimes", () => {
    const firstRoot = createFixtureRepository();
    const secondRoot = createFixtureRepository();
    setTreeMtime(firstRoot, new Date("2024-01-01T00:00:00Z"));
    setTreeMtime(secondRoot, new Date("2026-06-01T12:34:56Z"));

    const first = mainStage.assembleMainVsixStage({ repositoryRoot: firstRoot, sourceDateEpoch: SOURCE_DATE_EPOCH });
    const second = mainStage.assembleMainVsixStage({ repositoryRoot: secondRoot, sourceDateEpoch: SOURCE_DATE_EPOCH });

    assert.strictEqual(first.contentHash, second.contentHash);
    assert.ok(fs.readFileSync(first.contentsManifestFile).equals(fs.readFileSync(second.contentsManifestFile)));
    for (const relativePath of listFiles(first.stageRoot)) {
      assert.ok(
        fs.readFileSync(path.join(first.stageRoot, ...relativePath.split("/"))).equals(
          fs.readFileSync(path.join(second.stageRoot, ...relativePath.split("/")))
        ),
        relativePath
      );
    }
  });

  it("uses readable development JSON and an equivalent compact production form", () => {
    const repositoryRoot = createFixtureRepository();
    const development = mainStage.assembleMainVsixStage({
      repositoryRoot,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      bundleMode: "development"
    });
    const relativeJson = path.join("syntaxes", "rsgl.tmLanguage.json");
    const developmentBytes = fs.readFileSync(path.join(development.stageRoot, relativeJson));
    const developmentValue = JSON.parse(developmentBytes.toString("utf8")) as unknown;
    const developmentPaths = listFiles(development.stageRoot);
    const developmentIgnore = fs.readFileSync(
      path.join(development.stageRoot, ".vscodeignore"),
      "utf8"
    );
    assert.deepStrictEqual(
      developmentPaths,
      [...development.files.map(file => file.path)].sort()
    );
    assert.ok(!developmentIgnore.includes("**/*.map"));
    assert.ok(!mainStage.mainVsixDevelopmentGeneratedIgnore.includes("**/*.map"));
    for (const sourceMap of mainStage.mainVsixRuntimeSourceMaps) {
      assert.ok(developmentPaths.includes(sourceMap), sourceMap);
    }

    const production = mainStage.assembleMainVsixStage({
      repositoryRoot,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      bundleMode: "production"
    });
    const productionBytes = fs.readFileSync(path.join(production.stageRoot, relativeJson));
    assert.deepStrictEqual(JSON.parse(productionBytes.toString("utf8")), developmentValue);
    assert.ok(productionBytes.length < developmentBytes.length);
    assert.strictEqual(productionBytes.toString("utf8"), JSON.stringify(developmentValue));
    assert.notStrictEqual(production.contentHash, development.contentHash);
    assert.deepStrictEqual(
      developmentPaths,
      [...production.files.map(file => file.path), ...mainStage.mainVsixRuntimeSourceMaps].sort()
    );
    assert.ok(fs.readFileSync(path.join(production.stageRoot, ".vscodeignore"), "utf8")
      .startsWith("**/*.map\n"));
    for (const sourceMap of mainStage.mainVsixRuntimeSourceMaps) {
      assert.strictEqual(fs.existsSync(path.join(production.stageRoot, ...sourceMap.split("/"))), false);
    }
    assert.deepStrictEqual(mainStage.parseMainVsixStageArguments([]), {
      sourceDateEpoch: undefined,
      bundleMode: "production"
    });
    assert.deepStrictEqual(
      mainStage.parseMainVsixStageArguments(["--bundle-mode=development"]),
      { sourceDateEpoch: undefined, bundleMode: "development" }
    );
    assert.throws(
      () => mainStage.parseMainVsixStageArguments(["--bundle-mode", "analyze"]),
      /Unknown VSIX stage bundle mode/
    );
  });

  it("rejects maps, path escapes, case-folding collisions, and unsafe stage roots", () => {
    const root = createTemporaryRoot();
    const parent = path.join(root, "dist", "vsix-stage");
    const baseOptions = {
      stageRoot: path.join(parent, "main"),
      allowedStageParent: parent,
      contentsManifestFile: path.join(parent, "main.contents.json"),
      sourceDateEpoch: SOURCE_DATE_EPOCH
    };

    assert.throws(
      () => stageTree.assembleVsixStageTree({ ...baseOptions, files: [{ path: "bundle/app.js.map", content: "map" }] }),
      /Forbidden production stage file/
    );
    const development = stageTree.assembleVsixStageTree({
      ...baseOptions,
      files: [{ path: "bundle/app.js.map", content: "map" }],
      allowedForbiddenPaths: ["bundle/app.js.map"]
    });
    assert.deepStrictEqual(development.files.map(file => file.path), ["bundle/app.js.map"]);
    assert.throws(
      () => stageTree.assembleVsixStageTree({
        ...baseOptions,
        files: [{ path: "bundle/other.js.map", content: "map" }],
        allowedForbiddenPaths: ["bundle/app.js.map"]
      }),
      /Forbidden production stage file/
    );
    assert.throws(
      () => stageTree.assembleVsixStageTree({ ...baseOptions, files: [{ path: "../escape", content: "x" }] }),
      /escapes the stage root/
    );
    assert.throws(
      () => stageTree.assembleVsixStageTree({
        ...baseOptions,
        files: [{ path: "A.txt", content: "a" }, { path: "a.txt", content: "b" }]
      }),
      /collides/
    );
    assert.throws(
      () => stageTree.assembleVsixStageTree({
        ...baseOptions,
        stageRoot: parent,
        files: [{ path: "file.txt", content: "x" }]
      }),
      /must not equal its allowed parent/
    );
  });

  it("uses a validated SOURCE_DATE_EPOCH before falling back to Git", () => {
    const repositoryRoot = createTemporaryRoot();
    let gitReads = 0;
    assert.strictEqual(mainStage.resolveMainVsixSourceDateEpoch({
      repositoryRoot,
      environment: { SOURCE_DATE_EPOCH },
      readCommitTimestamp: () => {
        gitReads++;
        return "1800000000";
      }
    }), Number(SOURCE_DATE_EPOCH));
    assert.strictEqual(gitReads, 0);
    assert.strictEqual(mainStage.resolveMainVsixSourceDateEpoch({
      repositoryRoot,
      environment: {},
      readCommitTimestamp: () => "1800000000"
    }), 1800000000);
    assert.throws(
      () => mainStage.resolveMainVsixSourceDateEpoch({
        repositoryRoot,
        environment: { SOURCE_DATE_EPOCH: "not-a-timestamp" }
      }),
      /supported by ZIP/
    );
  });

  function createFixtureRepository(): string {
    const root = createTemporaryRoot();
    writeJson(root, "package.json", {
      name: "stage-fixture",
      version: "1.0.0",
      publisher: "fixture",
      engines: { vscode: "^1.100.0" },
      main: "./bundle/extension.js",
      icon: "icon.png",
      scripts: {
        "vscode:prepublish": "node scripts/build.mjs main --bundle-mode production",
        keep: "node keep.mjs"
      },
      dependencies: { runtime: "1.0.0" },
      devDependencies: { tooling: "1.0.0" },
      contributes: {
        languages: [{ id: "rsgl", configuration: "./language-configuration/rsgl.json" }],
        grammars: [{ language: "rsgl", scopeName: "source.rsgl", path: "./syntaxes/rsgl.tmLanguage.json" }],
        viewsContainers: { activitybar: [{ id: "fixture", icon: "assets/mcResHelperSidebar.svg" }] }
      }
    });
    writeJson(root, "package.nls.json", {
      "extension.displayName": "Main Fixture",
      "rsgl.command.build": "Build RSGL",
      "schema.rsglConfig.url": "./schemas/en/rsgl-config.schema.json",
      "schema.root.url": "./assets/linters/en/schema.json"
    });
    writeJson(root, "l10n/bundle.l10n.json", {
      "RSGL message": "RSGL message",
      "Root message": "Root message"
    });

    for (const [fileName, contents] of [
      ["README.md", "readme\n"],
      ["README_CN.md", "readme zh\n"],
      ["CHANGELOG.md", "changelog\n"],
      ["LICENSE", "root license\n"],
      ["icon.png", "png"],
      ["webviews/modelPreview/styles.css", "canvas { display: block; }\n"],
      ["webviews/modelPreview/main.js", "raw source"],
      ["webviews/modelPreview/vendor/three.module.js", "vendor source"],
      ["licenses/THREE-LICENSE.txt", "three license\n"],
      ["assets/mcResHelperSidebar.svg", "<svg/>\n"],
      ["assets/demo.gif", "gif"],
      ["bundle/rsgl/stdlib/conventions/example.rsgl", "// preserve source ranges\nresource demo\n"],
      ["node_modules/three/index.js", "dependency"],
      ["src/extension.ts", "source"],
      ["test/fixture.json", "{}"]
    ]) {
      writeFile(root, fileName, contents);
    }
    for (const bundle of mainStage.mainVsixRuntimeBundles) {
      writeFile(root, bundle, `production:${bundle}\n`);
      writeFile(root, `${bundle}.map`, `map:${bundle}\n`);
    }
    writeJson(root, "assets/linters/en/schema.json", { title: "Schema", type: "object" }, true);
    writeJson(root, "assets/cit/builtin-resource-ids.json", {
      schemaVersion: 1,
      defaultNamespace: "minecraft",
      items: ["stick"],
      enchantments: ["sharpness"],
      armorSuffixes: ["_helmet"]
    }, true);
    writeJson(root, "assets/cit/en/base.json", { id: "base", keys: {} }, true);
    writeJson(root, "language-configuration/rsgl.json", { comments: { lineComment: "//" } }, true);
    writeJson(root, "syntaxes/rsgl.tmLanguage.json", { scopeName: "source.rsgl", patterns: [] }, true);
    writeJson(root, "schemas/en/rsgl-config.schema.json", { title: "RSGL config", type: "object" }, true);
    return root;
  }

  function createTemporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-res-vsix-stage-"));
    temporaryRoots.push(root);
    return root;
  }
});

interface ContentsManifest {
  schemaVersion: number;
  sourceDateEpoch: string;
  contentHash: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function writeJson(root: string, relativePath: string, value: unknown, pretty = false): void {
  writeFile(root, relativePath, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

function writeFile(root: string, relativePath: string, contents: string | Buffer): void {
  const fileName = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, contents);
}

function readJson<T = Record<string, unknown>>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, relativeDirectory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit(root, "");
  return files.sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashManifestEntries(files: ContentsManifest["files"]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.bytes, file.sha256]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function assertNormalizedMtimes(root: string, expectedMtimeMs: number): void {
  const visit = (entryPath: string) => {
    const details = fs.statSync(entryPath);
    assert.ok(Math.abs(details.mtimeMs - expectedMtimeMs) < 2, `${entryPath}: ${details.mtimeMs}`);
    if (!details.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(entryPath)) {
      visit(path.join(entryPath, entry));
    }
  };
  visit(root);
}

function setTreeMtime(root: string, mtime: Date): void {
  const entries: string[] = [];
  const visit = (entryPath: string) => {
    entries.push(entryPath);
    if (fs.statSync(entryPath).isDirectory()) {
      for (const entry of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, entry));
      }
    }
  };
  visit(root);
  for (const entry of entries.reverse()) {
    fs.utimesSync(entry, mtime, mtime);
  }
}
