import * as assert from "node:assert";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const nodeRequire = createRequire(__filename);
const yazl = nodeRequire("yazl") as {
  ZipFile: new () => {
    addBuffer(bytes: Buffer, archivePath: string): void;
    addEmptyDirectory(archivePath: string): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  };
};

interface TreeIdentity {
  algorithm: string;
  sha256: string;
  files: number;
  directories: number;
  bytes: number;
}

interface PreparedResult {
  status: "created" | "reused" | "rebuilt";
  artifact: { sha256: string; bytes: number };
  artifactRoot: string;
  cacheEntryRoot: string;
  extensionRoot: string;
  markerPath: string;
  extensionTree: TreeIdentity;
  extractedTree: TreeIdentity;
}

interface PreparedVsixModule {
  PREPARED_VSIX_CACHE_SCHEMA_VERSION: number;
  PREPARED_VSIX_CACHE_RELATIVE_PATH: readonly string[];
  prepareVsixExtension(options: {
    artifactPath: string;
    repositoryRoot: string;
  }): Promise<PreparedResult>;
  hashPreparedExtensionTree(extensionRoot: string): Promise<TreeIdentity>;
  normalizeVsixArchivePath(value: string): string;
}

describe("prepared activation VSIX cache", () => {
  let preparedVsix: PreparedVsixModule;
  const preparedVsixModuleUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "activation-probe", "prepared-vsix.mjs")
  ).href;

  before(async () => {
    preparedVsix = await import(preparedVsixModuleUrl) as PreparedVsixModule;
  });

  it("extracts once into the digest-addressed repository cache and reuses a fully rehashed tree", async () => {
    const fixture = createFixture();
    try {
      const artifact = path.join(fixture.root, "artifacts with spaces", "组合扩展.vsix");
      await writeVsix(artifact, [
        ["extension/package.json", Buffer.from('{"name":"fixture"}\n')],
        ["extension/bundle/extension.js", Buffer.from("exports.activate = () => {};\n")],
        ["extension/assets/内容.txt", Buffer.from("stable payload")]
      ], ["extension/empty/"]);

      const first = await preparedVsix.prepareVsixExtension({
        artifactPath: artifact,
        repositoryRoot: fixture.root
      });
      assert.strictEqual(first.status, "created");
      assert.strictEqual(
        first.artifactRoot,
        path.join(fixture.root, ...preparedVsix.PREPARED_VSIX_CACHE_RELATIVE_PATH, first.artifact.sha256)
      );
      assert.strictEqual(path.dirname(first.cacheEntryRoot), first.artifactRoot);
      assert.strictEqual(
        path.basename(first.cacheEntryRoot),
        `${first.extensionTree.sha256}.g00000000`
      );
      assert.strictEqual(first.extensionRoot, path.join(first.cacheEntryRoot, "extension"));
      assert.strictEqual(fs.readFileSync(path.join(first.extensionRoot, "assets", "内容.txt"), "utf8"), "stable payload");
      assert.deepStrictEqual(first.extensionTree, first.extractedTree);
      assert.strictEqual(first.extensionTree.files, 3);
      assert.ok(first.extensionTree.directories >= 3);

      const markerBefore = fs.readFileSync(first.markerPath);
      const markerMtimeBefore = fs.statSync(first.markerPath).mtimeMs;
      const second = await preparedVsix.prepareVsixExtension({
        artifactPath: artifact,
        repositoryRoot: fixture.root
      });
      assert.strictEqual(second.status, "reused");
      assert.strictEqual(second.extensionRoot, first.extensionRoot);
      assert.deepStrictEqual(second.extractedTree, first.extractedTree);
      assert.deepStrictEqual(fs.readFileSync(second.markerPath), markerBefore);
      assert.strictEqual(fs.statSync(second.markerPath).mtimeMs, markerMtimeBefore);

      const marker = JSON.parse(fs.readFileSync(second.markerPath, "utf8")) as {
        schemaVersion: number;
        artifact: { sha256: string; bytes: number };
        extensionTree: TreeIdentity;
        extractedTree: TreeIdentity;
      };
      assert.strictEqual(marker.schemaVersion, preparedVsix.PREPARED_VSIX_CACHE_SCHEMA_VERSION);
      assert.deepStrictEqual(marker.artifact, second.artifact);
      assert.deepStrictEqual(marker.extensionTree, second.extensionTree);
      assert.deepStrictEqual(marker.extractedTree, second.extractedTree);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a forged file-and-marker pair against the source archive without deleting the old generation", async () => {
    const fixture = createFixture();
    try {
      const artifact = path.join(fixture.root, "candidate.vsix");
      await writeVsix(artifact, [
        ["extension/package.json", Buffer.from('{"name":"fixture"}')],
        ["extension/bundle/extension.js", Buffer.from("module.exports = {};\n")],
        ["extension/data/value.txt", Buffer.from("archive value")]
      ]);
      const first = await preparedVsix.prepareVsixExtension({ artifactPath: artifact, repositoryRoot: fixture.root });
      const firstValue = path.join(first.extensionRoot, "data", "value.txt");
      fs.writeFileSync(firstValue, "tampered cache value");
      const forgedTree = await preparedVsix.hashPreparedExtensionTree(first.extensionRoot);
      const forgedMarker = JSON.parse(fs.readFileSync(first.markerPath, "utf8")) as {
        extensionTree: TreeIdentity;
        extractedTree: TreeIdentity;
      };
      forgedMarker.extensionTree = forgedTree;
      forgedMarker.extractedTree = forgedTree;
      fs.writeFileSync(first.markerPath, `${JSON.stringify(forgedMarker, null, 2)}\n`);

      const rebuilt = await preparedVsix.prepareVsixExtension({ artifactPath: artifact, repositoryRoot: fixture.root });
      assert.strictEqual(rebuilt.status, "rebuilt");
      assert.notStrictEqual(rebuilt.cacheEntryRoot, first.cacheEntryRoot);
      assert.strictEqual(path.basename(rebuilt.cacheEntryRoot), `${first.extensionTree.sha256}.g00000001`);
      assert.strictEqual(fs.readFileSync(path.join(rebuilt.extensionRoot, "data", "value.txt"), "utf8"), "archive value");
      assert.deepStrictEqual(rebuilt.extensionTree, first.extensionTree);
      assert.deepStrictEqual(rebuilt.extractedTree, first.extractedTree);
      assert.deepStrictEqual(
        await preparedVsix.hashPreparedExtensionTree(rebuilt.extensionRoot),
        rebuilt.extractedTree
      );
      assert.ok(fs.existsSync(first.cacheEntryRoot), "a published generation must never be removed");
      assert.ok(fs.existsSync(first.extensionRoot), "a handed-out extensionRoot must remain present");
      assert.strictEqual(fs.readFileSync(firstValue, "utf8"), "tampered cache value");
      assert.deepStrictEqual(
        fs.readdirSync(rebuilt.artifactRoot).sort(),
        [path.basename(first.cacheEntryRoot), path.basename(rebuilt.cacheEntryRoot)].sort()
      );

      const stable = await preparedVsix.prepareVsixExtension({ artifactPath: artifact, repositoryRoot: fixture.root });
      assert.strictEqual(stable.status, "reused");
      assert.strictEqual(stable.cacheEntryRoot, rebuilt.cacheEntryRoot);
    } finally {
      fixture.cleanup();
    }
  });

  it("publishes one canonical generation under concurrent first prepares and selects it deterministically", async () => {
    const fixture = createFixture();
    try {
      const artifact = path.join(fixture.root, "parallel.vsix");
      await writeVsix(artifact, [
        ["extension/package.json", Buffer.from('{"name":"parallel"}')],
        ["extension/bundle/extension.js", Buffer.from("module.exports = {};\n")],
        ["extension/data/value.txt", Buffer.from("parallel archive value")]
      ]);

      const results = await Promise.all(Array.from({ length: 4 }, () => (
        preparedVsix.prepareVsixExtension({ artifactPath: artifact, repositoryRoot: fixture.root })
      )));
      assert.deepStrictEqual(new Set(results.map(result => result.cacheEntryRoot)).size, 1);
      assert.strictEqual(results.filter(result => result.status === "created").length, 1);
      assert.strictEqual(results.filter(result => result.status === "reused").length, 3);
      const canonical = results[0];
      assert.deepStrictEqual(fs.readdirSync(canonical.artifactRoot), [path.basename(canonical.cacheEntryRoot)]);

      const secondValidGeneration = path.join(
        canonical.artifactRoot,
        `${canonical.extensionTree.sha256}.g00000001`
      );
      fs.cpSync(canonical.cacheEntryRoot, secondValidGeneration, { recursive: true });
      const selected = await preparedVsix.prepareVsixExtension({
        artifactPath: artifact,
        repositoryRoot: fixture.root
      });
      assert.strictEqual(
        selected.cacheEntryRoot,
        canonical.cacheEntryRoot,
        "the lexically first valid immutable generation must be selected"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("coordinates atomic first publication across independent Node processes", async () => {
    const fixture = createFixture();
    try {
      const artifact = path.join(fixture.root, "multi-process.vsix");
      await writeVsix(artifact, [
        ["extension/package.json", Buffer.from('{"name":"multi-process"}')],
        ["extension/bundle/extension.js", Buffer.from("module.exports = {};\n")],
        ["extension/data/value.txt", Buffer.from("cross-process value")]
      ]);
      const results = await Promise.all(Array.from({ length: 3 }, () => (
        prepareInChildProcess(preparedVsixModuleUrl, artifact, fixture.root)
      )));
      assert.strictEqual(new Set(results.map(result => result.cacheEntryRoot)).size, 1);
      assert.strictEqual(results.filter(result => result.status === "created").length, 1);
      assert.strictEqual(results.filter(result => result.status === "reused").length, 2);
      assert.deepStrictEqual(
        fs.readdirSync(results[0].artifactRoot),
        [path.basename(results[0].cacheEntryRoot)]
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects traversal and Windows-unsafe archive paths before extraction", async () => {
    assert.throws(() => preparedVsix.normalizeVsixArchivePath("extension/../../escape.txt"), /escapes the archive root/);
    assert.throws(() => preparedVsix.normalizeVsixArchivePath("extension/C:/escape.txt"), /not portable to Windows/);
    assert.throws(() => preparedVsix.normalizeVsixArchivePath("extension/CON.txt"), /not portable to Windows/);
    for (const reserved of ["COM¹", "COM².txt", "COM³", "LPT¹.log", "LPT²", "LPT³.txt"]) {
      assert.throws(
        () => preparedVsix.normalizeVsixArchivePath(`extension/${reserved}`),
        /not portable to Windows/
      );
    }
    assert.throws(() => preparedVsix.normalizeVsixArchivePath("extension\\escape.txt"), /Unsafe VSIX entry path/);

    const fixture = createFixture();
    try {
      const artifact = path.join(fixture.root, "unsafe.vsix");
      await writeVsix(artifact, [
        ["extension/package.json", Buffer.from('{"name":"fixture"}')],
        ["extension/bundle/extension.js", Buffer.from("module.exports = {};\n")],
        ["extension/safe--escape.txt", Buffer.from("must not escape")]
      ]);
      replaceArchivePath(
        artifact,
        "extension/safe--escape.txt",
        "extension/../../escape.txt"
      );

      await assert.rejects(
        preparedVsix.prepareVsixExtension({ artifactPath: artifact, repositoryRoot: fixture.root }),
        /invalid relative path|escapes the archive root|Invalid VSIX archive/i
      );
      assert.deepStrictEqual(findFilesNamed(fixture.root, "escape.txt"), []);
    } finally {
      fixture.cleanup();
    }
  });
});

function createFixture(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcres prepared VSIX 测试 "));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function writeVsix(
  fileName: string,
  files: ReadonlyArray<readonly [string, Buffer]>,
  directories: readonly string[] = []
): Promise<void> {
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const [archivePath, bytes] of files) {
    zip.addBuffer(bytes, archivePath);
  }
  for (const archivePath of directories) {
    zip.addEmptyDirectory(archivePath);
  }
  zip.end();
  const output = fs.createWriteStream(fileName);
  return new Promise((resolve, reject) => {
    zip.outputStream.on("error", reject);
    output.on("error", reject);
    output.on("close", resolve);
    zip.outputStream.pipe(output);
  });
}

function replaceArchivePath(fileName: string, from: string, to: string): void {
  assert.strictEqual(Buffer.byteLength(from), Buffer.byteLength(to));
  const bytes = fs.readFileSync(fileName);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while (true) {
    const match = bytes.indexOf(source, offset);
    if (match < 0) {
      break;
    }
    replacement.copy(bytes, match);
    offset = match + replacement.length;
    replacements += 1;
  }
  assert.strictEqual(replacements, 2, "ZIP entry path must occur in its local and central headers");
  fs.writeFileSync(fileName, bytes);
}

function findFilesNamed(directory: string, name: string): string[] {
  const matches: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFilesNamed(fileName, name));
    } else if (entry.isFile() && entry.name === name) {
      matches.push(fileName);
    }
  }
  return matches;
}

function prepareInChildProcess(
  moduleUrl: string,
  artifactPath: string,
  repositoryRoot: string
): Promise<PreparedResult> {
  const source = [
    "const [moduleUrl, artifactPath, repositoryRoot] = process.argv.slice(1);",
    "const { prepareVsixExtension } = await import(moduleUrl);",
    "const result = await prepareVsixExtension({ artifactPath, repositoryRoot });",
    "process.stdout.write(JSON.stringify(result));"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      source,
      moduleUrl,
      artifactPath,
      repositoryRoot
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`Prepared VSIX child exited ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as PreparedResult);
      } catch (error) {
        reject(error);
      }
    });
  });
}
