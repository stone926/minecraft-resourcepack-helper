import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { RsglWorkspaceSourceCache } from "../../src/workspaceSource";
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

function readLetNumber(sourceFile: RsglSourceFile | undefined): number | undefined {
  const statement = sourceFile?.module.statements[0];
  if (statement?.kind === "LetDecl" && statement.value.kind === "NumberLiteral") {
    return statement.value.value;
  }
  return undefined;
}
