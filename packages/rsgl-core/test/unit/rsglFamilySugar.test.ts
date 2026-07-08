import * as assert from "node:assert";
import { type ResourceUnit } from "../../src/compiler";
import { compileSource, expectNoDiagnostics, unitByPath } from "./helpers/compile";

function assertExternalResource(
  units: readonly ResourceUnit[],
  outputPath: string,
  resourceKind: "model" | "blockstate" | "item" | "texture",
  id: string
): void {
  const unit = units.find(candidate => candidate.outputPath === outputPath);
  assert.ok(unit, `Expected external resource unit for ${outputPath}`);
  assert.deepStrictEqual(unit.external, { kind: "external", resourceKind, id });
  assert.strictEqual(unit.content, null);
}

describe("RSGL use semantics, extern declarations, and convention templates", () => {
  it("declares external resources without emitting files", () => {
    const result = compileSource([
      "extern model(id: minecraft:block/stone)",
      "extern blockstate(id: minecraft:stone)",
      "extern item(id: minecraft:stone)",
      "extern texture(id: minecraft:block/stone)"
    ]);

    expectNoDiagnostics(result);
    assertExternalResource(result.units, "assets/minecraft/models/block/stone.json", "model", "minecraft:block/stone");
    assertExternalResource(result.units, "assets/minecraft/blockstates/stone.json", "blockstate", "minecraft:stone");
    assertExternalResource(result.units, "assets/minecraft/items/stone.json", "item", "minecraft:stone");
    assertExternalResource(result.units, "assets/minecraft/textures/block/stone.png", "texture", "minecraft:block/stone");
  });

  it("lets generated resources override extern declarations", () => {
    const result = compileSource([
      "extern model(id: minecraft:block/stone)",
      "model block stone impl minecraft:block/cube_all(all: minecraft:block/stone) {",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.strictEqual(result.units.length, 1);
    assert.strictEqual(result.units[0].external, undefined);
  });

  it("lowers model impl clauses to parent and texture slots", () => {
    const result = compileSource([
      "model block ruby impl minecraft:block/cube_all(all: minecraft:block/ruby) {",
      "}",
      "model item diamond impl generated(layer0: minecraft:item/diamond) {",
      "}",
      "item diamond {",
      "  model minecraft:item/diamond",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/ruby.json").content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/ruby" }
    });
    assert.deepStrictEqual(unitByPath(result, "models/item/diamond.json").content, {
      parent: "minecraft:item/generated",
      textures: { layer0: "minecraft:item/diamond" }
    });
    assert.deepStrictEqual(unitByPath(result, "items/diamond.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("expands item and model convention templates from stdlib imports", () => {
    const result = compileSource([
      "import { cubeAllModel, generatedItem, simpleItem } from \"rsgl:conventions/items.rsgl\"",
      "use cubeAllModel(id: ruby, all: minecraft:block/ruby)",
      "use generatedItem(id: diamond, layer0: minecraft:item/diamond)",
      "use simpleItem(id: ruby_block, model: minecraft:block/ruby_block)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/items/ruby_block.json",
      "assets/minecraft/models/block/ruby.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
  });

  it("diagnoses removed top-level hardcoded use helpers", () => {
    const result = compileSource([
      "use externalModel(id: minecraft:block/stone)",
      "use cubeAll(id: ruby)",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)",
      "use blockFamily(base: acacia, texture: minecraft:block/acacia_planks)",
      "use stairs(id: ruby_stairs)"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.undefinedSymbol"));
    assert.ok(codes.includes("rsgl.notCallable"));
    assert.ok(codes.includes("rsgl.unknownTemplate"));
    assert.deepStrictEqual(result.units, []);
  });

  it("separates full blockstate templates from blockstate fragments", () => {
    const result = compileSource([
      "import { stairs } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "import { stairsBlockstate } from \"rsgl:conventions/blockstates.rsgl\"",
      "use stairsBlockstate(id: ruby_stairs)",
      "blockstate custom_stairs {",
      "  use stairs(",
      "    base: minecraft:block/custom_stairs,",
      "    inner: minecraft:block/custom_stairs_inner,",
      "    outer: minecraft:block/custom_stairs_outer",
      "  )",
      "}"
    ]);

    expectNoDiagnostics(result);
    const generated = unitByPath(result, "blockstates/ruby_stairs.json");
    const generatedVariants = (generated.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(generatedVariants).length, 40);
    assert.deepStrictEqual(generatedVariants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/ruby_stairs"
    });

    const custom = unitByPath(result, "blockstates/custom_stairs.json");
    const customVariants = (custom.content as { variants: Record<string, unknown> }).variants;
    assert.deepStrictEqual(customVariants["facing=east,half=bottom,shape=inner_left"], {
      model: "minecraft:block/custom_stairs_inner",
      y: 270,
      uvlock: true
    });
  });
});
