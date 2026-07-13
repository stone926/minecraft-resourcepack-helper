import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource, compileSourceWithUncheckedExterns, expectNoDiagnostics, expectOnlyLegacyTemplateWarnings } from "./helpers/compile";

describe("RSGL legacy item model backend", () => {
  it("lowers item mappings to legacy item model files for older targets", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java mc \"1.21.8\"",
      "model item diamond impl generated(layer0: minecraft:item/diamond) {}",
      "item acacia_stairs {",
      "  model block/acacia_stairs",
      "}",
      "item custom_tool {",
      "  model minecraft:item/diamond",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.filter(unit => !unit.external).map(unit => unit.outputPath).sort(), [
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
    const result = compileSourceWithUncheckedExterns([
      "target java format 64",
      "item wand {",
      "  range property minecraft:custom_model_data {",
      "    frames [1, 2] model `minecraft:item/wand_${index}`",
      "    fallback minecraft:item/wand",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.filter(unit => !unit.external).map(unit => unit.outputPath), [
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
    assert.deepStrictEqual(
      result.units[0].validation?.resourceValueObservations?.map(observation => [
        observation.generatedPath,
        observation.valueKind
      ]),
      [
        ["/textures/layer0", "texture"],
        ["/overrides/0/model", "model"],
        ["/overrides/1/model", "model"]
      ]
    );
  });

  it("validates and records external models referenced by lowered legacy overrides", () => {
    const dependencyRoot = path.resolve("legacy-item-externs");
    const result = compileSource([
      "target java format 64",
      "extern custom model minecraft:item/wand_base, minecraft:item/wand_0",
      "item wand {",
      "  range property minecraft:custom_model_data {",
      "    frames [1] model `minecraft:item/wand_${index}`",
      "    fallback minecraft:item/wand_base",
      "  }",
      "}"
    ], {
      externResourcePath: (_source, kind, id) => path.join(dependencyRoot, kind, id.replace(":", "_"))
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      result.units
        .filter(unit => unit.external?.resourceKind === "model")
        .map(unit => unit.external!.id)
        .sort(),
      ["minecraft:item/wand_0", "minecraft:item/wand_base"]
    );
    assert.deepStrictEqual(
      result.dependencies.map(dependency => dependency.path).sort(),
      [
        path.join(dependencyRoot, "model", "minecraft_item", "wand_0"),
        path.join(dependencyRoot, "model", "minecraft_item", "wand_base")
      ]
    );
  });

  it("does not index the original item id as a generated legacy model", () => {
    const result = compileSource([
      "target java format 64",
      "extern! vanilla texture minecraft:item/wand",
      "extern! vanilla model minecraft:item/generated",
      "item wand {",
      "  model minecraft:item/wand",
      "}",
      "blockstate variants wand_reference {",
      "  {}: { model: minecraft:wand }",
      "}"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    const legacyModel = result.units.find(unit => unit.outputPath.endsWith("models/item/wand.json"));
    assert.deepStrictEqual(legacyModel?.id, { namespace: "minecraft", path: "item/wand" });
  });

  it("preserves fixed and caller extern scopes after legacy item lowering", () => {
    const mainFile = path.resolve("legacy-item-scope", "main.rsgl");
    const templatesFile = path.resolve("legacy-item-scope", "templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { dispatch } from \"./templates.rsgl\"",
          "target java format 64",
          "extern! custom model minecraft:item/caller_model",
          "item wand { use dispatch(minecraft:item/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_model",
          "template dispatch(callerModel: ModelId) {",
          "  range property minecraft:custom_model_data {",
          "    frames [1] model callerModel",
          "    fallback minecraft:item/library_model",
          "  }",
          "}",
          "export { dispatch }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectOnlyLegacyTemplateWarnings(result);
    assert.deepStrictEqual(
      result.units
        .filter(unit => unit.external?.resourceKind === "model")
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:item/caller_model", "custom"],
        ["minecraft:item/library_model", "vanilla"]
      ]
    );
  });

  it("lowers legacy custom model data select cases", () => {
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
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

    const arrowOnly = compileSourceWithUncheckedExterns([
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
    const result = compileSourceWithUncheckedExterns([
      "target java format 64",
      "item bundle {",
      "  selected_item",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"));
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects component conditions in the legacy item backend", () => {
    const result = compileSourceWithUncheckedExterns([
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
