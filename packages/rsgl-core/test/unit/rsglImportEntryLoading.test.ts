import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile, loadRsglSourceFilesFromFile } from "../../src/compiler";
import { expectNoDiagnostics, generatedResourceUnits, withUncheckedExterns } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL import entry loading", () => {
  it("loads imported RSGL files from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const mainFile = path.join(packDir, "main.rsgl");
      const templatesFile = path.join(packDir, "templates.rsgl");
      const tablesFile = path.join(packDir, "tables.rsgl");
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(tablesFile, [
        "namespace custom",
        "let defaultParent: ModelId = minecraft:block/cube_all",
        "table woods {",
        "  acacia: texture_id(block/acacia_planks)",
        "}",
        "export { defaultParent, woods }"
      ].join("\n"));
      fs.writeFileSync(templatesFile, [
        "template cube(id: TextureId, texture: TextureId = id) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}",
        "export { cube }"
      ].join("\n"));
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "import { woods, defaultParent } from \"./tables.rsgl\"",
        "use cube(acacia_planks, texture: woods.acacia)",
        "model block spruce_planks {",
        "  parent defaultParent",
        "  textures { all: minecraft:block/spruce_planks }",
        "}"
      ].join("\n"));

      const loadedFiles = loadRsglSourceFilesFromFile(mainFile);
      assert.deepStrictEqual(loadedFiles.map(file => file.fileName).sort(), [
        mainFile,
        tablesFile,
        templatesFile
      ].map(fileName => path.normalize(path.resolve(fileName))).sort());

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));

      expectNoDiagnostics(result);
      assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
        "assets/minecraft/models/block/acacia_planks.json",
        "assets/minecraft/models/block/spruce_planks.json"
      ]);
      assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("acacia_planks.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "custom:block/acacia_planks"
        }
      });
      assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("spruce_planks.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/spruce_planks"
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads re-exported RSGL files from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const mainFile = path.join(packDir, "main.rsgl");
      const barrelFile = path.join(packDir, "barrel.rsgl");
      const templatesFile = path.join(packDir, "templates.rsgl");
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(templatesFile, [
        "template cube(id: ResourceId) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "  }",
        "}",
        "export { cube }"
      ].join("\n"));
      fs.writeFileSync(barrelFile, "export { cube } from \"./templates.rsgl\"");
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./barrel.rsgl\"",
        "use cube(stone)"
      ].join("\n"));

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));

      expectNoDiagnostics(result);
      assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath), [
        "assets/minecraft/models/block/stone.json"
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing and cyclic imports from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      const cycleFile = path.join(root, "cycle.rsgl");
      fs.writeFileSync(mainFile, [
        "import \"./missing.rsgl\"",
        "import \"./cycle.rsgl\"",
        "model block stone { parent minecraft:block/cube_all }"
      ].join("\n"));
      fs.writeFileSync(cycleFile, "import \"./main.rsgl\"\n");

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.missingImport"));
      assert.ok(codes.includes("rsgl.importCycle"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
