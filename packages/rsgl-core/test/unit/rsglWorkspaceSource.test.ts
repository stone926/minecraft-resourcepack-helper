import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { RsglWorkspaceSourceCache, type RsglWorkspaceSourceFileSystem } from "../../src/workspaceSource";
import { bindRsglProgram, RsglSourceFile } from "../../src/semantic";
import { createTempDir } from "./helpers/fs";

describe("RSGL workspace source cache", () => {
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
    const cache = new RsglWorkspaceSourceCache({ fileSystem: io.fileSystem });

    const first = cache.loadProgramFromEntry(mainFile)[0];
    const second = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(first), 1);
    assert.strictEqual(second, first);
    assert.strictEqual(io.reads, 1);

    io.write(mainFile, "let value = 2", 2);
    const third = cache.loadProgramFromEntry(mainFile)[0];

    assert.strictEqual(readLetNumber(third), 2);
    assert.notStrictEqual(third, first);
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
  write(fileName: string, text: string, mtimeMs: number): void;
} {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const counters = {
    reads: 0
  };

  for (const [fileName, file] of Object.entries(initialFiles)) {
    files.set(normalize(fileName), file);
  }

  return {
    get reads() {
      return counters.reads;
    },
    write(fileName, text, mtimeMs) {
      files.set(normalize(fileName), { text, mtimeMs });
    },
    fileSystem: {
      statFile(fileName) {
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
  return path.normalize(path.resolve(fileName));
}

function readLetNumber(sourceFile: RsglSourceFile | undefined): number | undefined {
  const statement = sourceFile?.module.statements[0];
  if (statement?.kind === "LetDecl" && statement.value.kind === "NumberLiteral") {
    return statement.value.value;
  }
  return undefined;
}
