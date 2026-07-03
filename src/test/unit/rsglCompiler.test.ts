import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglModule, compileRsglProgram, stableJsonStringify } from "../../rsgl/compiler";
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

  it("expands local templates with positional, named, and default arguments", () => {
    const result = compileRsglModule(parseRsgl([
      "template cube(id: ResourceId, texture: TextureId = id) {",
      "  model block id {",
      "    parent minecraft:block/cube_all",
      "    textures { all: texture }",
      "  }",
      "}",
      "use cube(stone, texture: minecraft:block/stone)"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
  });

  it("expands finite for loops over lists", () => {
    const result = compileRsglModule(parseRsgl([
      "for block in [minecraft:stone, minecraft:dirt] {",
      "  cube_all [block]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/dirt.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("expands product loops and template string interpolation", () => {
    const result = compileRsglModule(parseRsgl([
      "for state in product({ facing: [north, east], powered: [false, true] }) {",
      "  blockstate `lamp_${state.facing}_${state.powered}` {",
      "    variants {",
      "      {} -> { model: `minecraft:block/lamp_${state.facing}` }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/lamp_east_false.json",
      "assets/minecraft/blockstates/lamp_east_true.json",
      "assets/minecraft/blockstates/lamp_north_false.json",
      "assets/minecraft/blockstates/lamp_north_true.json"
    ]);
    const emptyVariantKey = "";
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("lamp_east_true.json"))?.content, {
      variants: {
        [emptyVariantKey]: {
          model: "minecraft:block/lamp_east"
        }
      }
    });
  });

  it("expands templates imported from another RSGL file", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cube as cubeModel } from \"./templates.rsgl\"",
          "use cubeModel(stone, texture: minecraft:block/stone)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: ResourceId, texture: TextureId = id) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: texture }",
          "  }",
          "}"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
    const mapping = result.units[0].sourceMap.mappings[0];
    assert.strictEqual(mapping.sourceFile, templatesFile);
    assert.strictEqual(mapping.reason, "template");
    assert.deepStrictEqual(mapping.expansionStack.map(frame => frame.label), ["use cubeModel"]);
  });

  it("reports output conflicts across compiled RSGL files", () => {
    const firstFile = path.resolve("pack", "first.rsgl");
    const secondFile = path.resolve("pack", "second.rsgl");
    const result = compileRsglProgram([
      {
        fileName: firstFile,
        module: parseRsgl("cube_all [stone]")
      },
      {
        fileName: secondFile,
        module: parseRsgl("model block stone { parent minecraft:block/cube_all }")
      }
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
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
