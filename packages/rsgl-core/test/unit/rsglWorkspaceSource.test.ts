import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathKey } from "../../../mc-assets/src";
import { RsglWorkspaceSourceCache, type RsglWorkspaceSourceFileSystem } from "../../src/workspaceSource";
import { bindRsglProgram, RsglSourceFile } from "../../src/semantic";
import { createTempDir } from "./helpers/fs";

describe("RSGL workspace source cache", () => {
  it("loads stdlib imports from the explicit installed root", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-source-stdlib-");
    const stdlibRoot = path.join(root, "installed stdlib 资源");
    try {
      fs.mkdirSync(stdlibRoot, { recursive: true });
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(mainFile, [
        "import { transportTemplate } from \"rsgl:__transport_test.rsgl\"",
        "use transportTemplate(stone)"
      ].join("\n"));
      fs.writeFileSync(path.join(stdlibRoot, "__transport_test.rsgl"), [
        "template transportTemplate(id: ResourceId) {",
        "  model block id { parent minecraft:block/cube_all }",
        "}",
        "export { transportTemplate }"
      ].join("\n"));

      const files = new RsglWorkspaceSourceCache({ stdlibRoot }).loadProgramFromEntry(mainFile);
      const program = bindRsglProgram(files);

      assert.ok(files.some(file => file.fileName.includes("__transport_test.rsgl")));
      assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads imports and re-exports using open document content", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-source-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./barrel.rsgl\"",
        "use cube(stone)"
      ].join("\n"));
      fs.writeFileSync(barrelFile, "export { cube } from \"./templates.rsgl\"");

      const cache = new RsglWorkspaceSourceCache();
      cache.setOpenTextDocumentProvider(fileName => path.normalize(fileName) === path.normalize(templatesFile)
        ? {
          fileName: templatesFile,
          version: 1,
          getText: () => [
            "template cube(id: ResourceId) {",
            "  model block id { parent minecraft:block/cube_all }",
            "}",
            "export { cube }"
          ].join("\n")
        }
        : null);

      const files = cache.loadProgramFromEntry(mainFile);
      const program = bindRsglProgram(files);

      assert.deepStrictEqual(files.map(file => file.fileName).sort(), [
        mainFile,
        barrelFile,
        templatesFile
      ].map(fileName => path.normalize(path.resolve(fileName))).sort());
      assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates cached source files by path", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-source-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(mainFile, "let value = 1");

      const cache = new RsglWorkspaceSourceCache();
      const first = cache.loadProgramFromEntry(mainFile)[0];
      fs.writeFileSync(mainFile, "let value = 2");
      cache.invalidatePath(mainFile);
      const second = cache.loadProgramFromEntry(mainFile)[0];

      assert.strictEqual(readLetNumber(first), 1);
      assert.strictEqual(readLetNumber(second), 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses parsed disk source files while mtime and size are unchanged", () => {
    const mainFile = path.resolve("virtual-source-cache", "main.rsgl");
    const io = createCountingSourceFileSystem({
      [mainFile]: { text: "let value = 1", mtimeMs: 1 }
    });
    const cache = new RsglWorkspaceSourceCache({
      fileSystem: io.fileSystem,
      verificationTtlMs: 0
    });

    const first = cache.loadProgramFromEntry(mainFile)[0];
    const second = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(first), 1);
    assert.strictEqual(second, first);
    assert.strictEqual(io.stats, 2);
    assert.strictEqual(io.reads, 1);

    io.write(mainFile, "let value = 2", 2);
    const third = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(third), 2);
    assert.notStrictEqual(third, first);
    assert.strictEqual(io.stats, 3);
    assert.strictEqual(io.reads, 2);
  });

  it("retains parsed source identity across unchanged preview open and close transitions", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-source-preview-");
    try {
      const mainFile = path.join(root, "preview.rsgl");
      const text = "let value = 1";
      let open = false;
      fs.writeFileSync(mainFile, text);

      const cache = new RsglWorkspaceSourceCache();
      cache.setOpenTextDocumentProvider(fileName => open && path.normalize(fileName) === path.normalize(mainFile)
        ? { fileName: mainFile, version: 1, getText: () => text }
        : null);

      const fromDisk = cache.loadProgramFromEntry(mainFile)[0];
      open = true;
      assert.strictEqual(cache.synchronizePath(mainFile), false);
      assert.strictEqual(cache.loadProgramFromEntry(mainFile)[0], fromDisk);

      open = false;
      assert.strictEqual(cache.synchronizePath(mainFile), false);
      assert.strictEqual(cache.loadProgramFromEntry(mainFile)[0], fromDisk);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches directory enumeration until TTL expiry or watcher invalidation", () => {
    const root = path.resolve("virtual-directory-cache");
    const mainFile = path.join(root, "main.rsgl");
    const io = createCountingSourceFileSystem({
      [mainFile]: { text: "let value = 1", mtimeMs: 1 }
    });
    let now = 10_000;
    let enumerations = 0;
    const cache = new RsglWorkspaceSourceCache({
      fileSystem: io.fileSystem,
      verificationTtlMs: 100,
      clock: () => now,
      enumerateRsglFiles: () => {
        enumerations++;
        return [mainFile];
      }
    });

    const first = cache.loadProgramFromDirectory(root)[0];
    const second = cache.loadProgramFromDirectory(root)[0];

    assert.strictEqual(second, first);
    assert.strictEqual(enumerations, 1);

    now += 100;
    cache.loadProgramFromDirectory(root);
    assert.strictEqual(enumerations, 2, "TTL expiry should verify the directory once");

    cache.invalidatePath(mainFile);
    cache.loadProgramFromDirectory(root);
    assert.strictEqual(enumerations, 3, "watcher invalidation should discard the listing");
  });

  it("performs no disk I/O on watcher-trusted cache hits until invalidated", () => {
    const mainFile = path.resolve("virtual-source-cache", "watcher-trusted.rsgl");
    const io = createCountingSourceFileSystem({
      [mainFile]: { text: "let value = 1", mtimeMs: 1 }
    });
    const cache = new RsglWorkspaceSourceCache({
      fileSystem: io.fileSystem,
      watcherTrusted: true
    });

    const first = cache.loadProgramFromEntry(mainFile)[0];
    io.write(mainFile, "let value = 2", 2);
    const cached = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(cached, first);
    assert.strictEqual(readLetNumber(cached), 1);
    assert.strictEqual(io.stats, 1);
    assert.strictEqual(io.reads, 1);

    cache.invalidatePath(mainFile);
    const refreshed = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(refreshed), 2);
    assert.notStrictEqual(refreshed, first);
    assert.strictEqual(io.stats, 2);
    assert.strictEqual(io.reads, 2);
  });

  it("uses TTL verification and reads only after the disk version changes", () => {
    const mainFile = path.resolve("virtual-source-cache", "ttl-verified.rsgl");
    const io = createCountingSourceFileSystem({
      [mainFile]: { text: "let value = 1", mtimeMs: 1 }
    });
    let now = 10_000;
    const cache = new RsglWorkspaceSourceCache({
      fileSystem: io.fileSystem,
      verificationTtlMs: 100,
      clock: () => now
    });

    const first = cache.loadProgramFromEntry(mainFile)[0];
    const withinTtl = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(withinTtl, first);
    assert.strictEqual(io.stats, 1);
    assert.strictEqual(io.reads, 1);

    now += 100;
    const verified = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(verified, first);
    assert.strictEqual(io.stats, 2, "TTL expiry should stat the file once");
    assert.strictEqual(io.reads, 1, "an unchanged version must not be read again");

    io.write(mainFile, "let value = 2", 2);
    now += 99;
    assert.strictEqual(cache.loadProgramFromEntry(mainFile)[0], first);
    assert.strictEqual(io.stats, 2);
    assert.strictEqual(io.reads, 1);

    now += 1;
    const refreshed = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(refreshed), 2);
    assert.notStrictEqual(refreshed, first);
    assert.strictEqual(io.stats, 3);
    assert.strictEqual(io.reads, 2);
  });

  it("uses one cache identity for Windows path-case variants", function () {
    if (process.platform !== "win32") {
      this.skip();
    }

    const mainFile = path.resolve("virtual-source-cache", "Main.rsgl");
    const caseVariant = mainFile.toUpperCase();
    const io = createCountingSourceFileSystem({
      [mainFile]: { text: "let value = 1", mtimeMs: 1 }
    });
    const cache = new RsglWorkspaceSourceCache({ fileSystem: io.fileSystem });

    const first = cache.loadProgramFromEntry(mainFile)[0];
    const second = cache.loadProgramFromEntry(caseVariant)[0];

    assert.strictEqual(second, first, "case variants must reuse the first parsed source value");
    assert.strictEqual(second.fileName, path.normalize(mainFile), "identity keys must not replace the display path");
    assert.strictEqual(io.reads, 1);

    io.write(mainFile, "let value = 2", 1);
    cache.invalidatePath(caseVariant);
    const refreshed = cache.loadProgramFromEntry(mainFile)[0];

    assert.notStrictEqual(refreshed, first);
    assert.strictEqual(readLetNumber(refreshed), 2);
    assert.strictEqual(io.reads, 2);
  });

  it("reloads unversioned open document content with the same length", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-source-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      let text = "let value = 1";
      const cache = new RsglWorkspaceSourceCache();
      cache.setOpenTextDocumentProvider(fileName => path.normalize(fileName) === path.normalize(mainFile)
        ? {
          fileName: mainFile,
          getText: () => text
        }
        : null);

      const first = cache.loadProgramFromEntry(mainFile)[0];
      text = "let value = 2";
      const second = cache.loadProgramFromEntry(mainFile)[0];

      assert.strictEqual(readLetNumber(first), 1);
      assert.strictEqual(readLetNumber(second), 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createCountingSourceFileSystem(initialFiles: Record<string, { text: string; mtimeMs: number }>): {
  fileSystem: RsglWorkspaceSourceFileSystem;
  reads: number;
  stats: number;
  write(fileName: string, text: string, mtimeMs: number): void;
} {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const counters = {
    reads: 0,
    stats: 0
  };

  for (const [fileName, file] of Object.entries(initialFiles)) {
    files.set(normalize(fileName), file);
  }

  return {
    get reads() {
      return counters.reads;
    },
    get stats() {
      return counters.stats;
    },
    write(fileName, text, mtimeMs) {
      files.set(normalize(fileName), { text, mtimeMs });
    },
    fileSystem: {
      statFile(fileName) {
        counters.stats++;
        const file = files.get(normalize(fileName));
        if (!file) {
          throw new Error(`Missing file: ${fileName}`);
        }
        return {
          mtimeMs: file.mtimeMs,
          size: Buffer.byteLength(file.text),
          isFile: () => true
        };
      },
      readTextFile(fileName) {
        counters.reads++;
        const file = files.get(normalize(fileName));
        if (!file) {
          throw new Error(`Missing file: ${fileName}`);
        }
        return file.text;
      }
    }
  };
}

function normalize(fileName: string): string {
  return normalizePathKey(path.resolve(fileName));
}

function readLetNumber(sourceFile: RsglSourceFile | undefined): number | undefined {
  const statement = sourceFile?.module.statements[0];
  if (statement?.kind === "LetDecl" && statement.value.kind === "NumberLiteral") {
    return statement.value.value;
  }
  return undefined;
}
