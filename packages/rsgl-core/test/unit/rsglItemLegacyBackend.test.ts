import * as assert from "node:assert";
import { compileSource, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL legacy item model backend", () => {
  it("lowers item mappings to legacy item model files for older targets", () => {
    const result = compileSource([
      "target java mc \"1.21.8\"",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)",
      "use itemModel(id: acacia_stairs, model: block/acacia_stairs)",
      "item custom_tool {",
      "  model minecraft:item/diamond",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/item/acacia_stairs.json",
      "assets/minecraft/models/item/custom_tool.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/acacia_stairs.json"))?.content, {
      parent: "minecraft:block/acacia_stairs"
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/custom_tool.json"))?.content, {
      parent: "minecraft:item/diamond"
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/diamond.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/diamond"
      }
    });
  });

  it("lowers custom model data item dispatch to legacy overrides", () => {
    const result = compileSource([
      "target java format 64",
      "item wand {",
      "  range property minecraft:custom_model_data {",
      "    frames [1, 2] model `minecraft:item/wand_${index}`",
      "    fallback minecraft:item/wand",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/item/wand.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/wand"
      },
      overrides: [
        {
          predicate: { ["custom_model_data"]: 1 },
          model: "minecraft:item/wand_0"
        },
        {
          predicate: { ["custom_model_data"]: 2 },
          model: "minecraft:item/wand_1"
        }
      ]
    });
    assert.strictEqual(result.units[0].kind, "model");
  });

  it("lowers legacy custom model data select cases", () => {
    const result = compileSource([
      "target java format 64",
      "item numbered {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:custom_model_data,",
      "    cases: [",
      "      { when: [1, 2], model: { type: minecraft:model, model: minecraft:item/numbered_one } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/numbered }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/numbered"
      },
      overrides: [
        {
          predicate: { ["custom_model_data"]: 1 },
          model: "minecraft:item/numbered_one"
        },
        {
          predicate: { ["custom_model_data"]: 2 },
          model: "minecraft:item/numbered_one"
        }
      ]
    });
  });

  it("flattens nested legacy item model predicates", () => {
    const result = compileSource([
      "target java format 64",
      "item bow {",
      "  model: {",
      "    type: minecraft:condition,",
      "    property: minecraft:using_item,",
      "    on_false: { type: minecraft:model, model: minecraft:item/bow },",
      "    on_true: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:custom_model_data,",
      "      fallback: { type: minecraft:model, model: minecraft:item/bow_pulling_0 },",
      "      entries: [",
      "        { threshold: 1, model: { type: minecraft:model, model: minecraft:item/bow_pulling_special } }",
      "      ]",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/bow"
      },
      overrides: [
        {
          predicate: { pulling: 1 },
          model: "minecraft:item/bow_pulling_0"
        },
        {
          predicate: {
            pulling: 1,
            ["custom_model_data"]: 1
          },
          model: "minecraft:item/bow_pulling_special"
        }
      ]
    });
  });

  it("keeps nested legacy on_false predicates below true branch overrides", () => {
    const result = compileSource([
      "target java format 64",
      "item bow {",
      "  model: {",
      "    type: minecraft:condition,",
      "    property: minecraft:using_item,",
      "    on_false: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:custom_model_data,",
      "      fallback: { type: minecraft:model, model: minecraft:item/bow },",
      "      entries: [",
      "        { threshold: 7, model: { type: minecraft:model, model: minecraft:item/bow_idle_special } }",
      "      ]",
      "    },",
      "    on_true: { type: minecraft:model, model: minecraft:item/bow_pulling }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/bow"
      },
      overrides: [
        {
          predicate: { ["custom_model_data"]: 7 },
          model: "minecraft:item/bow_idle_special"
        },
        {
          predicate: { pulling: 1 },
          model: "minecraft:item/bow_pulling"
        }
      ]
    });
  });

  it("maps additional modern item properties to legacy predicates", () => {
    const result = compileSource([
      "target java format 64",
      "item crossbow {",
      "  range property minecraft:crossbow/pull {",
      "    frames [0.58, 1.0] model `minecraft:item/crossbow_pulling_${index}`",
      "    fallback minecraft:item/crossbow",
      "  }",
      "}",
      "item fishing_rod {",
      "  condition property minecraft:fishing_rod/cast {",
      "    on_true minecraft:item/fishing_rod_cast",
      "    on_false minecraft:item/fishing_rod",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const crossbow = result.units.find(unit => unit.outputPath.endsWith("models/item/crossbow.json"));
    assert.deepStrictEqual(crossbow?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { pull: 0.58 },
          model: "minecraft:item/crossbow_pulling_0"
        },
        {
          predicate: { pull: 1 },
          model: "minecraft:item/crossbow_pulling_1"
        }
      ]
    });

    const fishingRod = result.units.find(unit => unit.outputPath.endsWith("models/item/fishing_rod.json"));
    assert.deepStrictEqual(fishingRod?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/fishing_rod"
      },
      overrides: [
        {
          predicate: { cast: 1 },
          model: "minecraft:item/fishing_rod_cast"
        }
      ]
    });
  });

  it("maps main hand selects to legacy lefthanded predicates", () => {
    const result = compileSource([
      "target java format 64",
      "item tool {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:main_hand,",
      "    cases: [",
      "      { when: \"right\", model: { type: minecraft:model, model: minecraft:item/tool_right } },",
      "      { when: \"left\", model: { type: minecraft:model, model: minecraft:item/tool_left } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/tool }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/tool"
      },
      overrides: [
        {
          predicate: { lefthanded: 0 },
          model: "minecraft:item/tool_right"
        },
        {
          predicate: { lefthanded: 1 },
          model: "minecraft:item/tool_left"
        }
      ]
    });
  });

  it("maps charge type selects to legacy crossbow predicates", () => {
    const result = compileSource([
      "target java format 64",
      "item crossbow {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:charge_type,",
      "    cases: [",
      "      { when: \"arrow\", model: { type: minecraft:model, model: minecraft:item/crossbow_arrow } },",
      "      { when: \"rocket\", model: { type: minecraft:model, model: minecraft:item/crossbow_firework } }",
      "    ],",
      "    fallback: {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_false: { type: minecraft:model, model: minecraft:item/crossbow },",
      "      on_true: {",
      "        type: minecraft:range_dispatch,",
      "        property: minecraft:crossbow/pull,",
      "        entries: [",
      "          { threshold: 0.58, model: { type: minecraft:model, model: minecraft:item/crossbow_pulling_1 } },",
      "          { threshold: 1.0, model: { type: minecraft:model, model: minecraft:item/crossbow_pulling_2 } }",
      "        ],",
      "        fallback: { type: minecraft:model, model: minecraft:item/crossbow_pulling_0 }",
      "      }",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { pulling: 1 },
          model: "minecraft:item/crossbow_pulling_0"
        },
        {
          predicate: { pulling: 1, pull: 0.58 },
          model: "minecraft:item/crossbow_pulling_1"
        },
        {
          predicate: { pulling: 1, pull: 1 },
          model: "minecraft:item/crossbow_pulling_2"
        },
        {
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow_firework"
        }
      ]
    });

    const arrowOnly = compileSource([
      "target java format 64",
      "item crossbow {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:charge_type,",
      "    cases: [",
      "      { when: \"arrow\", model: { type: minecraft:model, model: minecraft:item/crossbow_arrow } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/crossbow }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(arrowOnly);
    assert.deepStrictEqual(arrowOnly.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow"
        }
      ]
    });
  });

  it("reports unsupported item models in the legacy item backend", () => {
    const result = compileSource([
      "target java format 64",
      "item bundle {",
      "  selected_item",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"));
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects component conditions in the legacy item backend", () => {
    const result = compileSource([
      "target java format 50",
      "item bundle {",
      "  condition property minecraft:has_component component minecraft:bundle_contents {",
      "    on_true minecraft:item/bundle_filled",
      "    on_false {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_true: { type: minecraft:model, model: minecraft:item/bundle_open },",
      "      on_false: { type: minecraft:model, model: minecraft:item/bundle }",
      "    }",
      "  }",
      "}"
    ]);

    const unsupported = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel");
    assert.ok(unsupported);
    assert.match(unsupported.message, /supported property/);
    assert.deepStrictEqual(result.units, []);
  });
});
