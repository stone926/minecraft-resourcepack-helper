import * as assert from "node:assert/strict";
import { compileSourceWithUncheckedExterns, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL blockstate bodies and fragments", () => {
  it("expands for statements inside canonical blockstate variants", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants lamp {",
      "  for state in product({ facing: [north, east], powered: [false, true] }) {",
      "    case { facing: state.facing, powered: state.powered } => `minecraft:block/lamp_${state.facing}`",
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
      "/variants/facing=east,powered=false/model",
      "/variants/facing=east,powered=true",
      "/variants/facing=east,powered=true/model",
      "/variants/facing=north,powered=false",
      "/variants/facing=north,powered=false/model",
      "/variants/facing=north,powered=true",
      "/variants/facing=north,powered=true/model"
    ].sort());
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => /^\/variants\/[^/]+$/.test(mapping.generatedPath))
      .map(mapping => mapping.reason), ["loop", "loop", "loop", "loop"]);
  });

  it("expands for and if statements inside canonical blockstate multipart roots", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate multipart oak_fence {",
      "  part always => minecraft:block/oak_fence_post",
      "  for side in [north, east] {",
      "    part when $state[side] == true => `minecraft:block/oak_fence_side_${side}`",
      "  }",
      "  if false {",
      "    part always => minecraft:block/unused",
      "  } else {",
      "    part when $state.west == true => minecraft:block/oak_fence_side_west",
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
            north: "true"
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_east"
          },
          when: {
            east: "true"
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_west"
          },
          when: {
            west: "true"
          }
        }
      ]
    });
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath).sort(), [
      "",
      "/multipart",
      "/multipart/0",
      "/multipart/0/apply",
      "/multipart/0/apply/model",
      "/multipart/1",
      "/multipart/1/apply",
      "/multipart/1/apply/model",
      "/multipart/1/when",
      "/multipart/2",
      "/multipart/2/apply",
      "/multipart/2/apply/model",
      "/multipart/2/when",
      "/multipart/3",
      "/multipart/3/apply",
      "/multipart/3/apply/model",
      "/multipart/3/when"
    ].sort());
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => mapping.generatedPath === "/multipart/1" || mapping.generatedPath === "/multipart/2")
      .map(mapping => mapping.reason), ["loop", "loop"]);
  });

  it("expands stdlib blockstate fragments from imported templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stairs, slab } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "blockstate variants acacia_stairs {",
      "  use stairs(base: minecraft:block/acacia_stairs, inner: minecraft:block/acacia_stairs_inner, outer: minecraft:block/acacia_stairs_outer)",
      "}",
      "blockstate variants acacia_slab {",
      "  use slab(bottom: minecraft:block/acacia_slab, top: minecraft:block/acacia_slab_top, double: minecraft:block/acacia_planks)",
      "}"
    ]);

    expectNoDiagnostics(result);
    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    const slab = result.units.find(unit => unit.outputPath.endsWith("acacia_slab.json"));
    assert.ok(stairs);
    assert.ok(slab);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
    assert.deepStrictEqual(variants["facing=north,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs",
      uvlock: true,
      y: 270
    });
    assert.deepStrictEqual(slab.content, {
      variants: {
        ["type=bottom"]: { model: "minecraft:block/acacia_slab" },
        ["type=double"]: { model: "minecraft:block/acacia_planks" },
        ["type=top"]: { model: "minecraft:block/acacia_slab_top" }
      }
    });
  });

  it("lowers canonical random choices inside blockstate variants", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants stone {",
      "  case * => random {",
      "    option minecraft:block/stone weight 3",
      "    option minecraft:block/stone_mirrored with { y: 180 }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        [defaultVariantKey]: [
          { model: "minecraft:block/stone", weight: 3 },
          { model: "minecraft:block/stone_mirrored", y: 180 }
        ]
      }
    });
  });

  it("expands user blockstate section templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "template lampFacing(modelId: ModelId, states: Json = HORIZONTAL) -> variants {",
      "    for facing in states {",
      "      case { facing } => modelId with { y: yaw(facing) }",
      "    }",
      "}",
      "template connectedPane(post: ModelId, side: ModelId) -> multipart {",
      "    part always => post",
      "    for facing in [north, east] {",
      "      part when $state[facing] == true => side with { y: yaw(facing) }",
      "    }",
      "}",
      "blockstate variants lamp {",
      "  use lampFacing(minecraft:block/lamp)",
      "}",
      "blockstate multipart pane {",
      "  use connectedPane(minecraft:block/pane_post, minecraft:block/pane_side)",
      "}"
    ]);

    expectNoDiagnostics(result);
    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    const pane = result.units.find(unit => unit.outputPath.endsWith("pane.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: { model: "minecraft:block/lamp" },
        ["facing=east"]: { model: "minecraft:block/lamp", y: 90 },
        ["facing=south"]: { model: "minecraft:block/lamp", y: 180 },
        ["facing=west"]: { model: "minecraft:block/lamp", y: 270 }
      }
    });
    assert.deepStrictEqual(pane?.content, {
      multipart: [
        { apply: { model: "minecraft:block/pane_post" } },
        { when: { north: "true" }, apply: { model: "minecraft:block/pane_side" } },
        { when: { east: "true" }, apply: { model: "minecraft:block/pane_side", y: 90 } }
      ]
    });
  });

  it("supports parameterized blockstate templates used by real-world packs", () => {
    const result = compileSourceWithUncheckedExterns([
      "let suffix = \"lamp\"",
      "template keyed(property: String, prop1: String, modelId: ModelId) -> variants {",
      "    case { [property]: full, [prop1]: false } =>",
      "      modelId with { y: yaw(east) }",
      "}",
      "blockstate variants example {",
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

  it("parses multiline random choice options", () => {
    const result = compileSourceWithUncheckedExterns([
      "let block = \"powder_snow\"",
      "blockstate variants snow {",
      "  case * => random {",
      "    option `minecraft:block/${block}`",
      "    option `minecraft:block/${block}` with { y: 90 }",
      "    option `minecraft:block/${block}` with { y: 180 }",
      "    option `minecraft:block/${block}` with { y: 270 }",
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
    const result = compileSourceWithUncheckedExterns([
      "blockstate multipart sensor {",
      "  let poweredStates = 1..3",
      "  part when $state.power in poweredStates => minecraft:block/sensor_powered",
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

  it("reports incompatible blockstate template use in canonical root contexts", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stairs } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "blockstate multipart broken {",
      "  use stairs(base: minecraft:block/stairs, inner: minecraft:block/stairs_inner, outer: minecraft:block/stairs_outer)",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.templateOutputDialectMismatch"));
    assert.strictEqual(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.incompatibleBlockstateFragment"), false);
  });

});
