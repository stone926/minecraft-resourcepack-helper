import * as assert from "node:assert";
import { compileSourceWithUncheckedExterns, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL blockstate bodies and fragments", () => {
  it("expands for statements inside blockstate variants", () => {
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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

  it("expands stdlib blockstate fragments from imported templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stairs, slab } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "blockstate acacia_stairs {",
      "  use stairs(base: minecraft:block/acacia_stairs, inner: minecraft:block/acacia_stairs_inner, outer: minecraft:block/acacia_stairs_outer)",
      "}",
      "blockstate acacia_slab {",
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

  it("lowers random apply sugar inside explicit blockstate variants", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate stone {",
      "  variants {",
      "    {} -> random [",
      "      @minecraft:block/stone weight=3,",
      "      @minecraft:block/stone_mirrored y=180",
      "    ]",
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
      "      { facing: facing } -> { model: modelId, y: yaw(facing) }",
      "    }",
      "}",
      "template connectedPane(post: ModelId, side: ModelId) -> multipart {",
      "    apply { model: post }",
      "    for facing in [north, east] {",
      "      when { [facing]: true } apply { model: side, y: yaw(facing) }",
      "    }",
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
    const result = compileSourceWithUncheckedExterns([
      "let suffix = \"lamp\"",
      "template keyed(property: String, prop1: String, modelId: ModelId) -> variants {",
      "    [property=full prop1=false] ->",
      "      @modelId y=yaw(east)",
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
      "import { stairs } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "blockstate broken {",
      "  multipart {",
      "    use stairs(base: minecraft:block/stairs, inner: minecraft:block/stairs_inner, outer: minecraft:block/stairs_outer)",
      "  }",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.templateOutputDialectMismatch"));
    assert.strictEqual(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.incompatibleBlockstateFragment"), false);
  });

  it("reports removed randomVariants function calls", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate broken {",
      "  variants {",
      "    {} -> randomVariants({ bad: true })",
      "  }",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.undefinedSymbol"));
  });

  it("reports undefined symbols for removed hardcoded blockstate fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate broken {",
      "  use horizontalFacing(model: minecraft:block/furnace, state: [north])",
      "  use axisRotated(vertical: minecraft:block/oak_log, horizontal: minecraft:block/oak_log_horizontal)",
      "}",
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.undefinedSymbol").length, 2);
  });
});
