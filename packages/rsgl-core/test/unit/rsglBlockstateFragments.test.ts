import * as assert from "node:assert";
import { compileSource, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL blockstate bodies and fragments", () => {
  it("expands for statements inside blockstate variants", () => {
    const result = compileSource([
      "blockstate lamp {",
      "  variants {",
      "    for state in product({ facing: [north, east], powered: [false, true] }) {",
      "      [facing=state.facing powered=state.powered] -> { model: `minecraft:block/lamp_${state.facing}` }",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const expectedVariants = {
      ["facing=east,powered=false"]: {
        model: "minecraft:block/lamp_east"
      },
      ["facing=east,powered=true"]: {
        model: "minecraft:block/lamp_east"
      },
      ["facing=north,powered=false"]: {
        model: "minecraft:block/lamp_north"
      },
      ["facing=north,powered=true"]: {
        model: "minecraft:block/lamp_north"
      }
    };
    assert.deepStrictEqual(result.units[0].content, {
      variants: expectedVariants
    });
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath).sort(), [
      "",
      "/variants",
      "/variants/facing=east,powered=false",
      "/variants/facing=east,powered=true",
      "/variants/facing=north,powered=false",
      "/variants/facing=north,powered=true"
    ].sort());
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => mapping.generatedPath.startsWith("/variants/facing="))
      .map(mapping => mapping.reason), ["loop", "loop", "loop", "loop"]);
  });

  it("expands for and if statements inside blockstate multipart sections", () => {
    const result = compileSource([
      "blockstate oak_fence {",
      "  multipart {",
      "    apply { model: minecraft:block/oak_fence_post }",
      "    for side in [north, east] {",
      "      when { [side]: true } apply { model: `minecraft:block/oak_fence_side_${side}` }",
      "    }",
      "    if false {",
      "      apply { model: minecraft:block/unused }",
      "    } else {",
      "      when { west: true } apply { model: minecraft:block/oak_fence_side_west }",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/oak_fence_post"
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_north"
          },
          when: {
            north: true
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_east"
          },
          when: {
            east: true
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_west"
          },
          when: {
            west: true
          }
        }
      ]
    });
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/multipart",
      "/multipart/0",
      "/multipart/1",
      "/multipart/2",
      "/multipart/3"
    ]);
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => mapping.generatedPath === "/multipart/1" || mapping.generatedPath === "/multipart/2")
      .map(mapping => mapping.reason), ["loop", "loop"]);
  });

  it("expands built-in blockstate fragments from use declarations", () => {
    const result = compileSource([
      "blockstate acacia_stairs {",
      "  use stairs(base: minecraft:block/acacia_stairs, inner: minecraft:block/acacia_stairs_inner, outer: minecraft:block/acacia_stairs_outer)",
      "}",
      "blockstate oak_fence {",
      "  multipart {",
      "    use fence(post: minecraft:block/oak_fence_post, side: minecraft:block/oak_fence_side)",
      "  }",
      "}",
      "blockstate acacia_fence_gate {",
      "  use fenceGate(",
      "    base: minecraft:block/acacia_fence_gate,",
      "    open: minecraft:block/acacia_fence_gate_open,",
      "    wall: minecraft:block/acacia_fence_gate_wall,",
      "    wallOpen: minecraft:block/acacia_fence_gate_wall_open",
      "  )",
      "}",
      "blockstate acacia_door {",
      "  use door(",
      "    bottomLeft: minecraft:block/acacia_door_bottom_left,",
      "    bottomLeftOpen: minecraft:block/acacia_door_bottom_left_open,",
      "    bottomRight: minecraft:block/acacia_door_bottom_right,",
      "    bottomRightOpen: minecraft:block/acacia_door_bottom_right_open,",
      "    topLeft: minecraft:block/acacia_door_top_left,",
      "    topLeftOpen: minecraft:block/acacia_door_top_left_open,",
      "    topRight: minecraft:block/acacia_door_top_right,",
      "    topRightOpen: minecraft:block/acacia_door_top_right_open",
      "  )",
      "}",
      "blockstate acacia_trapdoor {",
      "  use trapdoor(",
      "    bottom: minecraft:block/acacia_trapdoor_bottom,",
      "    top: minecraft:block/acacia_trapdoor_top,",
      "    open: minecraft:block/acacia_trapdoor_open",
      "  )",
      "}",
      "blockstate glass_pane {",
      "  use pane(",
      "    post: minecraft:block/glass_pane_post,",
      "    side: minecraft:block/glass_pane_side,",
      "    sideAlt: minecraft:block/glass_pane_side_alt,",
      "    noSide: minecraft:block/glass_pane_noside,",
      "    noSideAlt: minecraft:block/glass_pane_noside_alt",
      "  )",
      "}",
      "blockstate furnace {",
      "  use horizontalFacing(model: minecraft:block/furnace, state: { lit: false })",
      "}",
      "blockstate oak_log {",
      "  use axisRotated(vertical: minecraft:block/oak_log, horizontal: minecraft:block/oak_log_horizontal)",
      "}",
      "blockstate oak_leaves {",
      "  use randomVariants(",
      "    state: { persistent: false },",
      "    models: [",
      "      { model: minecraft:block/oak_leaves, weight: 2 },",
      "      { model: minecraft:block/oak_leaves_2 }",
      "    ]",
      "  )",
      "}"
    ]);

    expectNoDiagnostics(result);
    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("oak_fence.json"));
    const fenceGate = result.units.find(unit => unit.outputPath.endsWith("acacia_fence_gate.json"));
    const door = result.units.find(unit => unit.outputPath.endsWith("acacia_door.json"));
    const trapdoor = result.units.find(unit => unit.outputPath.endsWith("acacia_trapdoor.json"));
    const pane = result.units.find(unit => unit.outputPath.endsWith("glass_pane.json"));
    const furnace = result.units.find(unit => unit.outputPath.endsWith("furnace.json"));
    const log = result.units.find(unit => unit.outputPath.endsWith("oak_log.json"));
    const leaves = result.units.find(unit => unit.outputPath.endsWith("oak_leaves.json"));
    assert.ok(stairs);
    assert.ok(fence);
    assert.ok(fenceGate);
    assert.ok(door);
    assert.ok(trapdoor);
    assert.ok(pane);
    assert.ok(furnace);
    assert.ok(log);
    assert.ok(leaves);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
    assert.deepStrictEqual(fence.content, {
      multipart: [
        { apply: { model: "minecraft:block/oak_fence_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/oak_fence_side" } },
        { when: { east: true }, apply: { model: "minecraft:block/oak_fence_side", y: 90, uvlock: true } },
        { when: { south: true }, apply: { model: "minecraft:block/oak_fence_side", y: 180, uvlock: true } },
        { when: { west: true }, apply: { model: "minecraft:block/oak_fence_side", y: 270, uvlock: true } }
      ]
    });
    const fenceGateVariants = (fenceGate.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(fenceGateVariants).length, 16);
    assert.deepStrictEqual(fenceGateVariants["facing=west,in_wall=false,open=true"], {
      model: "minecraft:block/acacia_fence_gate_open",
      uvlock: true,
      y: 90
    });
    const doorVariants = (door.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(doorVariants).length, 32);
    assert.deepStrictEqual(doorVariants["facing=south,half=upper,hinge=left,open=true"], {
      model: "minecraft:block/acacia_door_top_left_open",
      y: 180
    });
    const trapdoorVariants = (trapdoor.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(trapdoorVariants).length, 16);
    assert.deepStrictEqual(trapdoorVariants["facing=west,half=top,open=true"], {
      model: "minecraft:block/acacia_trapdoor_open",
      x: 180,
      y: 90
    });
    assert.deepStrictEqual(pane.content, {
      multipart: [
        { apply: { model: "minecraft:block/glass_pane_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/glass_pane_side" } },
        { when: { east: true }, apply: { model: "minecraft:block/glass_pane_side", y: 90 } },
        { when: { south: true }, apply: { model: "minecraft:block/glass_pane_side_alt" } },
        { when: { west: true }, apply: { model: "minecraft:block/glass_pane_side_alt", y: 90 } },
        { when: { north: false }, apply: { model: "minecraft:block/glass_pane_noside" } },
        { when: { east: false }, apply: { model: "minecraft:block/glass_pane_noside_alt" } },
        { when: { south: false }, apply: { model: "minecraft:block/glass_pane_noside_alt", y: 90 } },
        { when: { west: false }, apply: { model: "minecraft:block/glass_pane_noside", y: 270 } }
      ]
    });
    assert.deepStrictEqual(furnace.content, {
      variants: {
        ["facing=east,lit=false"]: { model: "minecraft:block/furnace", y: 90 },
        ["facing=north,lit=false"]: { model: "minecraft:block/furnace" },
        ["facing=south,lit=false"]: { model: "minecraft:block/furnace", y: 180 },
        ["facing=west,lit=false"]: { model: "minecraft:block/furnace", y: 270 }
      }
    });
    assert.deepStrictEqual(log.content, {
      variants: {
        ["axis=x"]: { model: "minecraft:block/oak_log_horizontal", x: 90, y: 90 },
        ["axis=y"]: { model: "minecraft:block/oak_log" },
        ["axis=z"]: { model: "minecraft:block/oak_log_horizontal", x: 90 }
      }
    });
    assert.deepStrictEqual(leaves.content, {
      variants: {
        ["persistent=false"]: [
          { model: "minecraft:block/oak_leaves", weight: 2 },
          { model: "minecraft:block/oak_leaves_2" }
        ]
      }
    });
  });

  it("lowers randomVariants inside explicit blockstate variants", () => {
    const result = compileSource([
      "blockstate stone {",
      "  variants {",
      "    {} -> randomVariants([",
      "      { model: minecraft:block/stone, weight: 3 },",
      "      { model: minecraft:block/stone_mirrored, y: 180, weight: 1 }",
      "    ])",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        [defaultVariantKey]: [
          { model: "minecraft:block/stone", weight: 3 },
          { model: "minecraft:block/stone_mirrored", y: 180, weight: 1 }
        ]
      }
    });
  });

  it("expands user blockstate section templates", () => {
    const result = compileSource([
      "template lampFacing(modelId: ModelId, states: Json = HORIZONTAL) {",
      "  variants {",
      "    for facing in states {",
      "      { facing: facing } -> { model: modelId, y: yaw(facing) }",
      "    }",
      "  }",
      "}",
      "template connectedPane(post: ModelId, side: ModelId) {",
      "  multipart {",
      "    apply { model: post }",
      "    for facing in [north, east] {",
      "      when { [facing]: true } apply { model: side, y: yaw(facing) }",
      "    }",
      "  }",
      "}",
      "blockstate lamp {",
      "  variants {",
      "    use lampFacing(minecraft:block/lamp)",
      "  }",
      "}",
      "blockstate pane {",
      "  use connectedPane(minecraft:block/pane_post, minecraft:block/pane_side)",
      "}"
    ]);

    expectNoDiagnostics(result);
    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    const pane = result.units.find(unit => unit.outputPath.endsWith("pane.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: { model: "minecraft:block/lamp", y: 0 },
        ["facing=east"]: { model: "minecraft:block/lamp", y: 90 },
        ["facing=south"]: { model: "minecraft:block/lamp", y: 180 },
        ["facing=west"]: { model: "minecraft:block/lamp", y: 270 }
      }
    });
    assert.deepStrictEqual(pane?.content, {
      multipart: [
        { apply: { model: "minecraft:block/pane_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/pane_side", y: 0 } },
        { when: { east: true }, apply: { model: "minecraft:block/pane_side", y: 90 } }
      ]
    });
  });

  it("supports parameterized blockstate templates used by real-world packs", () => {
    const result = compileSource([
      "let suffix = \"lamp\"",
      "template keyed(property: String, prop1: String, modelId: ModelId) {",
      "  variants {",
      "    [property=full prop1=false] ->",
      "      @modelId y=yaw(east)",
      "  }",
      "}",
      "blockstate example {",
      "  use keyed(\"tilt\", \"powered\", `minecraft:block/${suffix}`)",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        ["powered=false,tilt=full"]: {
          model: "minecraft:block/lamp",
          y: 90
        }
      }
    });
  });

  it("parses newline blockstate values and comma-separated random apply entries", () => {
    const result = compileSource([
      "let block = \"powder_snow\"",
      "blockstate snow {",
      "  variants {",
      "    {} ->",
      "      random [",
      "        @`minecraft:block/${block}`, @`minecraft:block/${block}` y=90,",
      "        @`minecraft:block/${block}` y=180, @`minecraft:block/${block}` y=270",
      "      ]",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        [defaultVariantKey]: [
          { model: "minecraft:block/powder_snow" },
          { model: "minecraft:block/powder_snow", y: 90 },
          { model: "minecraft:block/powder_snow", y: 180 },
          { model: "minecraft:block/powder_snow", y: 270 }
        ]
      }
    });
  });

  it("evaluates local let declarations inside multipart sections", () => {
    const result = compileSource([
      "blockstate sensor {",
      "  multipart {",
      "    let poweredStates = \"1|2|3\"",
      "    when { power: poweredStates } apply @minecraft:block/sensor_powered",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          when: { power: "1|2|3" },
          apply: { model: "minecraft:block/sensor_powered" }
        }
      ]
    });
  });

  it("reports incompatible blockstate template use in section contexts", () => {
    const result = compileSource([
      "blockstate broken {",
      "  variants {",
      "    use fence(post: minecraft:block/fence_post, side: minecraft:block/fence_side)",
      "  }",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.incompatibleBlockstateFragment"));
  });

  it("reports invalid randomVariants arguments", () => {
    const result = compileSource([
      "blockstate broken {",
      "  variants {",
      "    {} -> randomVariants({ bad: true })",
      "  }",
      "  use randomVariants(models: [{ bad: true }])",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidRandomVariantsArgument"));
    assert.ok(codes.includes("rsgl.invalidRandomVariantEntry"));
  });

  it("reports invalid blockstate template state arguments", () => {
    const result = compileSource([
      "blockstate broken {",
      "  use horizontalFacing(model: minecraft:block/furnace, state: [north])",
      "  use axisRotated(vertical: minecraft:block/oak_log, horizontal: minecraft:block/oak_log_horizontal, state: { axis: x })",
      "}",
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidTemplateStateArgument"));
    assert.ok(codes.includes("rsgl.templateStateConflict"));
  });
});
