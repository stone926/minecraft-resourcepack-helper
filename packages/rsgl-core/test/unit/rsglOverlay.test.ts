import * as assert from "node:assert";
import { compileRsglModule } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL pack overlays", () => {
  it("lowers overlay blocks to prefixed resources and pack metadata", () => {
    const result = compileSourceWithUncheckedExterns([
      "pack {",
      "  description \"Generated\"",
      "}",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block stone {",
      "    parent minecraft:block/cube_all",
      "    textures { all: minecraft:block/stone }",
      "  }",
      "  item stone {",
      "    model minecraft:block/stone",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
      "future/assets/minecraft/items/stone.json",
      "future/assets/minecraft/models/block/stone.json",
      "pack.mcmeta"
    ]);
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath === "pack.mcmeta")?.content, {
      pack: {
        description: "Generated"
      },
      overlays: {
        entries: [
          {
            directory: "future",
            ["min_format"]: [90, 0],
            ["max_format"]: [91, 0]
          }
        ]
      }
    });
    const model = generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("models/block/stone.json"));
    assert.strictEqual(model?.sourceMap.generatedFile, "future/assets/minecraft/models/block/stone.json");
    assert.deepStrictEqual(model?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/all"
    ]);
    assert.deepStrictEqual(model?.sourceMap.mappings.map(mapping => mapping.expansionStack.map(frame => frame.label)), [
      ["overlay future"],
      ["overlay future"],
      ["overlay future"],
      ["overlay future"]
    ]);
  });

  it("keeps overlay resources separate from base resource conflicts", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block stone { parent minecraft:block/cube_all }",
      "overlay \"future\" {",
      "  model block stone { parent minecraft:block/cube_all }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/stone.json",
      "future/assets/minecraft/models/block/stone.json",
      "pack.mcmeta"
    ]);
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath === "pack.mcmeta")?.content, {
      overlays: {
        entries: [
          {
            directory: "future"
          }
        ]
      }
    });
  });

  it("reports duplicate overlay directories at the duplicate overlay declaration", () => {
    const source = [
      "overlay \"future\" {",
      "  model block stone { parent minecraft:block/cube_all }",
      "}",
      "overlay \"future\" {",
      "  item stone { model minecraft:block/stone }",
      "}"
    ].join("\n");
    const secondOverlayStart = source.indexOf("overlay \"future\"", source.indexOf("overlay \"future\"") + 1);
    const result = compileRsglModule(parseRsgl(source), withUncheckedExterns({}));
    const duplicate = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.duplicateOverlayDirectory");
    const pack = generatedResourceUnits(result).find(unit => unit.outputPath === "pack.mcmeta");

    assert.ok(duplicate);
    assert.strictEqual(duplicate.range.start, secondOverlayStart);
    assert.deepStrictEqual(pack?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "/overlays/entries/0",
      "/overlays/entries/1"
    ]);
  });
});
