import * as assert from "node:assert";
import { compileRsglModule, type ResourceUnit } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource, expectNoDiagnostics, unitByPath } from "./helpers/compile";

function assertExternalResource(
  units: readonly ResourceUnit[],
  outputPath: string,
  resourceKind: "model" | "blockstate" | "item",
  id: string
): void {
  const unit = units.find(candidate => candidate.outputPath === outputPath);
  assert.ok(unit, `Expected external resource unit for ${outputPath}`);
  assert.deepStrictEqual(unit.external, { kind: "external", resourceKind, id });
  assert.strictEqual(unit.content, null);
}

describe("RSGL use declarations and block family sugar", () => {
  it("lowers top-level blockstate template uses to blockstates", () => {
    const result = compileSource([
      "use stairs(id: acacia_stairs)",
      "use slab(id: acacia_slab, double: minecraft:block/acacia_planks)",
      "use fence(id: oak_fence)",
      "use wall(id: cobblestone_wall)",
      "use pane(id: glass_pane)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/blockstates/cobblestone_wall.json",
      "assets/minecraft/blockstates/glass_pane.json",
      "assets/minecraft/blockstates/oak_fence.json"
    ]);

    const stairs = unitByPath(result, "acacia_stairs.json");
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
    const pane = unitByPath(result, "glass_pane.json");
    assert.deepStrictEqual((pane.content as { multipart: unknown[] }).multipart[8], {
      when: { west: false },
      apply: { model: "minecraft:block/glass_pane_noside", y: 270 }
    });
  });

  it("lowers stairs use custom model patterns", () => {
    const result = compileRsglModule(parseRsgl("use stairs(id: acacia_stairs, models: \"minecraft:block/stair/{id}\")"));
    const variants = (result.units[0].content as { variants: Record<string, Record<string, unknown>> }).variants;

    expectNoDiagnostics(result);
    assert.strictEqual(variants["facing=east,half=bottom,shape=straight"].model, "minecraft:block/stair/acacia_stairs");
    assert.strictEqual(variants["facing=east,half=bottom,shape=inner_left"].model, "minecraft:block/stair/acacia_stairs_inner");
    assert.strictEqual(variants["facing=east,half=bottom,shape=outer_left"].model, "minecraft:block/stair/acacia_stairs_outer");
  });

  it("lowers cube and item mapping use declarations", () => {
    const result = compileSource([
      "use cubeAll(id: stone)",
      "use cubeAll(id: smooth_stone, texture: block/smooth_stone)",
      "use itemModel(id: diamond)",
      "use itemModel(id: acacia_stairs, model: block/acacia_stairs)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/acacia_stairs.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/smooth_stone.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("lowers builtin use declarations to resources", () => {
    const result = compileSource([
      "use cubeAll(id: stone, texture: minecraft:block/stone)",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/stone.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/stone.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/diamond.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/diamond"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/diamond.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("lowers blockFamily builtin use to linked resources", () => {
    const result = compileSource([
      "use blockFamily(",
      "  base: minecraft:acacia,",
      "  texture: minecraft:block/acacia_planks,",
      "  variants: [cube, slab, stairs],",
      "  itemModels: true",
      ")"
    ]);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    expectNoDiagnostics(result);
    assert.strictEqual(outputPaths.length, 12);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_planks.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_slab.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_stairs.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_planks.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/acacia_stairs_inner.json"));
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_planks.json", "model", "minecraft:block/acacia_planks");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_planks.json", "item", "minecraft:acacia_planks");
    assert.ok(result.units[0].sourceMap.mappings[0].expansionStack.some(frame => frame.label === "blockFamily acacia"));
  });

  it("lowers blockFamily use to linked resources", () => {
    const result = compileSource([
      "use blockFamily(",
      "  base: acacia,",
      "  texture: minecraft:block/acacia_planks,",
      "  variants: [planks, slab, stairs, fence, fence_gate]",
      ")"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_fence.json",
      "assets/minecraft/blockstates/acacia_fence_gate.json",
      "assets/minecraft/blockstates/acacia_planks.json",
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/items/acacia_fence.json",
      "assets/minecraft/items/acacia_fence_gate.json",
      "assets/minecraft/items/acacia_planks.json",
      "assets/minecraft/items/acacia_slab.json",
      "assets/minecraft/items/acacia_stairs.json",
      "assets/minecraft/models/block/acacia_fence_gate.json",
      "assets/minecraft/models/block/acacia_fence_gate_open.json",
      "assets/minecraft/models/block/acacia_fence_gate_wall.json",
      "assets/minecraft/models/block/acacia_fence_gate_wall_open.json",
      "assets/minecraft/models/block/acacia_fence_inventory.json",
      "assets/minecraft/models/block/acacia_fence_post.json",
      "assets/minecraft/models/block/acacia_fence_side.json",
      "assets/minecraft/models/block/acacia_planks.json",
      "assets/minecraft/models/block/acacia_slab.json",
      "assets/minecraft/models/block/acacia_slab_top.json",
      "assets/minecraft/models/block/acacia_stairs.json",
      "assets/minecraft/models/block/acacia_stairs_inner.json",
      "assets/minecraft/models/block/acacia_stairs_outer.json"
    ]);

    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_planks.json", "model", "minecraft:block/acacia_planks");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_planks.json", "blockstate", "minecraft:acacia_planks");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_stairs_inner.json", "model", "minecraft:block/acacia_stairs_inner");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_fence.json", "item", "minecraft:acacia_fence");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_fence_gate_wall_open.json", "model", "minecraft:block/acacia_fence_gate_wall_open");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_fence_gate.json", "blockstate", "minecraft:acacia_fence_gate");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_fence_gate.json", "item", "minecraft:acacia_fence_gate");
  });

  it("reports unsupported family members", () => {
    const result = compileSource([
      "use blockFamily(",
      "  base: acacia,",
      "  texture: minecraft:block/acacia_planks,",
      "  variants: [recipe]",
      ")"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedFamilyMember"));
  });

  it("lowers wall and pane family members", () => {
    const result = compileSource([
      "use blockFamily(base: glass, texture: minecraft:block/glass, variants: [wall, pane])"
    ]);

    expectNoDiagnostics(result);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/glass_wall.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/glass_pane.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/glass_wall.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/glass_pane.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/glass_wall_inventory.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/glass_pane_noside.json"));

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/glass_wall_side_tall.json"))?.content, {
      parent: "minecraft:block/template_wall_side_tall",
      textures: {
        wall: "minecraft:block/glass"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/glass_pane_side_alt.json"))?.content, {
      parent: "minecraft:block/template_glass_pane_side_alt",
      textures: {
        pane: "minecraft:block/glass",
        edge: "minecraft:block/glass"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/glass_wall.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/glass_wall_inventory"
      }
    });
    const paneBlockstate = result.units.find(unit => unit.outputPath.endsWith("blockstates/glass_pane.json"));
    assert.deepStrictEqual((paneBlockstate?.content as { multipart: unknown[] }).multipart[8], {
      when: { west: false },
      apply: { model: "minecraft:block/glass_pane_noside", y: 270 }
    });
  });

  it("lowers door and trapdoor family members", () => {
    const result = compileSource([
      "use blockFamily(base: acacia, variants: [door, trapdoor])"
    ]);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    expectNoDiagnostics(result);
    assert.strictEqual(outputPaths.length, 16);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_door.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_trapdoor.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_door.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_trapdoor.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_door.json"));

    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_door_bottom_left.json", "model", "minecraft:block/acacia_door_bottom_left");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_trapdoor_open.json", "model", "minecraft:block/acacia_trapdoor_open");
    assertExternalResource(result.units, "assets/minecraft/models/item/acacia_door.json", "model", "minecraft:item/acacia_door");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_door.json", "item", "minecraft:acacia_door");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_trapdoor.json", "item", "minecraft:acacia_trapdoor");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_door.json", "blockstate", "minecraft:acacia_door");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_trapdoor.json", "blockstate", "minecraft:acacia_trapdoor");
  });

  it("lowers button, pressure plate, and sign family members", () => {
    const result = compileSource([
      "use blockFamily(base: acacia, variants: [button, pressure_plate, sign])"
    ]);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    expectNoDiagnostics(result);
    assert.strictEqual(outputPaths.length, 18);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_button.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_pressure_plate.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_wall_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_button.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_pressure_plate.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_sign.json"));

    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_button_pressed.json", "model", "minecraft:block/acacia_button_pressed");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_pressure_plate_down.json", "model", "minecraft:block/acacia_pressure_plate_down");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_sign_rot_2.json", "model", "minecraft:block/acacia_sign_rot_2");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_wall_sign.json", "model", "minecraft:block/acacia_wall_sign");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_button.json", "blockstate", "minecraft:acacia_button");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_pressure_plate.json", "blockstate", "minecraft:acacia_pressure_plate");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_sign.json", "blockstate", "minecraft:acacia_sign");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_wall_sign.json", "blockstate", "minecraft:acacia_wall_sign");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_sign.json", "item", "minecraft:acacia_sign");
  });

  it("lowers hanging sign and boat family members", () => {
    const result = compileSource([
      "use blockFamily(base: acacia, variants: [hanging_sign, boat, chest_boat])"
    ]);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    expectNoDiagnostics(result);
    assert.strictEqual(outputPaths.length, 17);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_wall_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_chest_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_chest_boat.json"));

    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_hanging_sign_attached_rot_0.json", "model", "minecraft:block/acacia_hanging_sign_attached_rot_0");
    assertExternalResource(result.units, "assets/minecraft/models/block/acacia_wall_hanging_sign.json", "model", "minecraft:block/acacia_wall_hanging_sign");
    assertExternalResource(result.units, "assets/minecraft/models/item/acacia_chest_boat.json", "model", "minecraft:item/acacia_chest_boat");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_hanging_sign.json", "blockstate", "minecraft:acacia_hanging_sign");
    assertExternalResource(result.units, "assets/minecraft/blockstates/acacia_wall_hanging_sign.json", "blockstate", "minecraft:acacia_wall_hanging_sign");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_boat.json", "item", "minecraft:acacia_boat");
    assertExternalResource(result.units, "assets/minecraft/items/acacia_chest_boat.json", "item", "minecraft:acacia_chest_boat");
  });

  it("uses hanging sign particle defaults and overrides", () => {
    const bamboo = compileSource([
      "use blockFamily(base: bamboo, variants: [hanging_sign])"
    ]);
    const custom = compileSource([
      "use blockFamily(",
      "  base: acacia,",
      "  hangingSignParticle: custom:block/hanging_post,",
      "  variants: [hanging_sign]",
      ")"
    ]);

    expectNoDiagnostics(bamboo);
    expectNoDiagnostics(custom);
    assertExternalResource(bamboo.units, "assets/minecraft/models/block/bamboo_hanging_sign_rot_0.json", "model", "minecraft:block/bamboo_hanging_sign_rot_0");
    assert.deepStrictEqual(custom.units.find(unit => unit.outputPath.endsWith("models/block/acacia_hanging_sign_rot_0.json"))?.content, {
      parent: "minecraft:block/template_hanging_sign_rot_0",
      textures: {
        all: "minecraft:block/acacia_hanging_sign",
        particle: "custom:block/hanging_post"
      }
    });
  });
});
