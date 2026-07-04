import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RsglWorkspaceSemanticCache } from "../../rsgl/workspaceSemantic";

describe("RSGL workspace semantic cache", () => {
  it("reuses the bound program while the source graph is unchanged", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "use cube(minecraft:block/stone)"
      ].join("\n"));
      fs.writeFileSync(templatesFile, [
        "template cube(id: ResourceId) {",
        "  model block id { parent minecraft:block/cube_all }",
        "}"
      ].join("\n"));

      const cache = RsglWorkspaceSemanticCache.create();
      const first = cache.loadProgramFromEntry(mainFile);
      const second = cache.loadProgramFromEntry(mainFile);

      assert.strictEqual(second.program, first.program);
      assert.strictEqual(second.files[0], first.files[0]);
      assert.deepStrictEqual(second.program.diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates dependent semantic programs when an imported file changes", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      let templateText = [
        "template cube(id: ResourceId) {",
        "  model block id { parent minecraft:block/cube_all }",
        "}"
      ].join("\n");
      let templateVersion = 1;
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "use cube(minecraft:block/stone)"
      ].join("\n"));
      fs.writeFileSync(templatesFile, templateText);

      const cache = RsglWorkspaceSemanticCache.create();
      cache.setOpenTextDocumentProvider(fileName => path.normalize(fileName) === path.normalize(templatesFile)
        ? {
          fileName: templatesFile,
          version: templateVersion,
          getText: () => templateText
        }
        : null);

      const first = cache.loadProgramFromEntry(mainFile);
      assert.deepStrictEqual(first.program.diagnostics.map(diagnostic => diagnostic.code), []);

      templateText = [
        "template cube(id: ResourceId, texture: TextureId) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}"
      ].join("\n");
      templateVersion++;
      cache.invalidatePath(templatesFile);

      const second = cache.loadProgramFromEntry(mainFile);
      assert.notStrictEqual(second.program, first.program);
      assert.ok(second.program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingArgument"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-semantic-"));
}
