import * as assert from "node:assert";
import { compileRsglModule, stableJsonStringify } from "../../rsgl/compiler";
import { parseRsgl } from "../../rsgl/parser";

describe("RSGL compiler", () => {
  it("emits explicit model, item, and blockstate resources", () => {
    const result = compileRsglModule(parseRsgl([
      "namespace minecraft",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/stone }",
      "}",
      "item diamond {",
      "  model minecraft:item/diamond",
      "}",
      "blockstate stone {",
      "  variants {",
      "    {} -> { model: minecraft:block/stone }",
      "  }",
      "}"
    ].join("\n")), { fileName: "pack/rsgl/main.rsgl" });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/stone.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/stone.json"
    ]);

    const model = result.units.find(unit => unit.kind === "model");
    assert.ok(model);
    assert.strictEqual(stableJsonStringify(model.content, model.kind), [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const item = result.units.find(unit => unit.kind === "item");
    assert.deepStrictEqual(item?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("lowers stairs, slab, fence, and wall sugar to blockstates", () => {
    const result = compileRsglModule(parseRsgl([
      "stairs acacia_stairs",
      "slab acacia_slab double minecraft:block/acacia_planks",
      "fence oak_fence",
      "wall cobblestone_wall"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/blockstates/cobblestone_wall.json",
      "assets/minecraft/blockstates/oak_fence.json"
    ]);

    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    assert.ok(stairs);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
  });

  it("lowers cube_all and items model batch sugar", () => {
    const result = compileRsglModule(parseRsgl([
      "cube_all [",
      "  stone",
      "  smooth_stone -> block/smooth_stone",
      "]",
      "items model [",
      "  diamond",
      "  acacia_stairs -> block/acacia_stairs",
      "]"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/acacia_stairs.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/smooth_stone.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("reports output path conflicts", () => {
    const result = compileRsglModule(parseRsgl([
      "cube_all [stone]",
      "model block stone { parent minecraft:block/cube_all }"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
  });

  it("validates generated resource references and target-gated fields", () => {
    const result = compileRsglModule(parseRsgl([
      "model block stone {",
      "  parent minecraft:block/missing_parent",
      "  textures { all: minecraft:block/missing_texture }",
      "}",
      "blockstate stone {",
      "  variants {",
      "    {} -> { model: minecraft:block/missing_model, z: 90, weight: 0 }",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 74 },
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
    assert.ok(codes.includes("rsgl.invalidRandomWeight"));
  });
});
