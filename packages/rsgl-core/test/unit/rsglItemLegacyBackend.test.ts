import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource, compileSourceWithUncheckedExterns, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL legacy item model backend", () => {
  it("lowers item mappings to legacy item model files for older targets", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "model item diamond impl minecraft:item/generated(layer0: minecraft:item/diamond) {}",
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
      "target java format 43",
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

  it("converts lossless legacy range options and canonical threshold order", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item wand {",
      "  range property minecraft:custom_model_data index 0 scale 2 {",
      "    entry 2 => minecraft:item/wand_two",
      "    entry 1 => minecraft:item/wand_one",
      "    fallback minecraft:item/wand",
      "  }",
      "}",
      "item damaged_tool {",
      "  range property minecraft:damage normalize true scale 2 {",
      "    entry 0.5 => minecraft:item/damaged_tool_used",
      "    fallback minecraft:item/damaged_tool",
      "  }",
      "}",
      "item clock {",
      "  range property minecraft:time natural_only true wobble true scale 2 {",
      "    entry 0.5 => minecraft:item/clock_half",
      "    fallback minecraft:item/clock",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const wand = result.units.find(unit => unit.outputPath.endsWith("models/item/wand.json"));
    assert.deepStrictEqual(
      wand?.content,
      {
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/wand" },
        overrides: [
          { predicate: { custom_model_data: 0.5 }, model: "minecraft:item/wand_one" },
          { predicate: { custom_model_data: 1 }, model: "minecraft:item/wand_two" }
        ]
      }
    );
    const sortedOverrideOrigins = (wand?.validation?.referenceOrigins ?? []).filter(origin =>
      /^\/overrides\/\d+\/model$/.test(origin.generatedPath)
    );
    assert.deepStrictEqual(
      sortedOverrideOrigins.map(origin => origin.generatedPath),
      ["/overrides/0/model", "/overrides/1/model"]
    );
    assert.ok(
      sortedOverrideOrigins[0].sourceRange.start > sortedOverrideOrigins[1].sourceRange.start,
      "sorted legacy overrides must retain the source range of their original entry"
    );
    assert.deepStrictEqual(
      result.units.find(unit => unit.outputPath.endsWith("models/item/damaged_tool.json"))?.content,
      {
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/damaged_tool" },
        overrides: [
          { predicate: { damage: 0.25 }, model: "minecraft:item/damaged_tool_used" }
        ]
      }
    );
    assert.deepStrictEqual(
      result.units.find(unit => unit.outputPath.endsWith("models/item/clock.json"))?.content,
      {
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/clock" },
        overrides: [
          { predicate: { time: 0.25 }, model: "minecraft:item/clock_half" }
        ]
      }
    );
  });

  it("validates and records external models referenced by lowered legacy overrides", () => {
    const dependencyRoot = path.resolve("legacy-item-externs");
    const result = compileSource([
      "target java format 43",
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
      "target java format 43",
      "extern! vanilla texture minecraft:item/wand",
      "extern! vanilla model minecraft:item/generated",
      "item wand {",
      "  model minecraft:item/wand",
      "}",
      "blockstate variants wand_reference {",
      "  case * => minecraft:wand",
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
          "target java format 43",
          "extern! custom model minecraft:item/caller_model",
          "use dispatch(minecraft:item/caller_model)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_model",
          "template dispatch(callerModel: ModelId) {",
          "  item wand {",
          "    range property minecraft:custom_model_data {",
          "      frames [1] model callerModel",
          "      fallback minecraft:item/library_model",
          "    }",
          "  }",
          "}",
          "export { dispatch }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
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
      "target java format 43",
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

  it("flattens nested lossless legacy item model predicates", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item bow {",
      "  model: {",
      "    type: minecraft:condition,",
      "    property: minecraft:damaged,",
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
          predicate: { damaged: 1 },
          model: "minecraft:item/bow_pulling_0"
        },
        {
          predicate: {
            damaged: 1,
            ["custom_model_data"]: 1
          },
          model: "minecraft:item/bow_pulling_special"
        }
      ]
    });
  });

  it("keeps nested legacy on_false predicates below true branch overrides", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item bow {",
      "  model: {",
      "    type: minecraft:condition,",
      "    property: minecraft:damaged,",
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
          predicate: { damaged: 1 },
          model: "minecraft:item/bow_pulling"
        }
      ]
    });
  });

  it("maps additional modern item properties to legacy predicates", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
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
      "target java format 43",
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
      "target java format 43",
      "item crossbow {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:charge_type,",
      "    cases: [",
      "      { when: \"arrow\", model: { type: minecraft:model, model: minecraft:item/crossbow_arrow } },",
      "      { when: \"rocket\", model: { type: minecraft:model, model: minecraft:item/crossbow_firework } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/crossbow }",
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
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow_firework"
        }
      ]
    });
  });

  it("restores the complete fallback tree after an arrow-only charge case", () => {
    const source = [
      "target java format 43",
      "item crossbow {",
      "  select property minecraft:charge_type {",
      "    case \"arrow\" => minecraft:item/crossbow_arrow",
      "    fallback range property minecraft:custom_model_data {",
      "      entry 7 => minecraft:item/crossbow_idle_seven",
      "      entry 3 => minecraft:item/crossbow_idle_three",
      "      fallback minecraft:item/crossbow",
      "    }",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { custom_model_data: 3 },
          model: "minecraft:item/crossbow_idle_three"
        },
        {
          predicate: { custom_model_data: 7 },
          model: "minecraft:item/crossbow_idle_seven"
        },
        {
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow"
        },
        {
          predicate: { charged: 1, firework: 1, custom_model_data: 3 },
          model: "minecraft:item/crossbow_idle_three"
        },
        {
          predicate: { charged: 1, firework: 1, custom_model_data: 7 },
          model: "minecraft:item/crossbow_idle_seven"
        }
      ]
    });

    const origins = result.units[0].validation?.referenceOrigins ?? [];
    assert.deepStrictEqual(
      origins.find(origin => origin.generatedPath === "/textures/layer0")?.sourceRange,
      origins.find(origin => origin.generatedPath === "/overrides/3/model")?.sourceRange
    );
    assert.deepStrictEqual(
      origins.find(origin => origin.generatedPath === "/overrides/0/model")?.sourceRange,
      origins.find(origin => origin.generatedPath === "/overrides/4/model")?.sourceRange
    );
    assert.deepStrictEqual(
      origins.find(origin => origin.generatedPath === "/overrides/1/model")?.sourceRange,
      origins.find(origin => origin.generatedPath === "/overrides/5/model")?.sourceRange
    );

    const observations = result.units[0].validation?.resourceValueObservations ?? [];
    assert.deepStrictEqual(
      observations.map(observation => observation.generatedPath),
      [
        "/textures/layer0",
        "/overrides/0/model",
        "/overrides/1/model",
        "/overrides/2/model",
        "/overrides/3/model",
        "/overrides/4/model",
        "/overrides/5/model"
      ]
    );
    assert.deepStrictEqual(
      observations.find(observation => observation.generatedPath === "/overrides/0/model")?.range,
      observations.find(observation => observation.generatedPath === "/overrides/4/model")?.range
    );
    assert.deepStrictEqual(
      observations.find(observation => observation.generatedPath === "/overrides/1/model")?.range,
      observations.find(observation => observation.generatedPath === "/overrides/5/model")?.range
    );
  });

  it("rejects general using_item conditions instead of assuming pulling semantics", () => {
    const source = [
      "target java format 43",
      "item food {",
      "  condition property minecraft:using_item {",
      "    on_true minecraft:item/food_eating",
      "    on_false minecraft:item/food",
      "  }",
      "}",
      "item trident {",
      "  condition property minecraft:using_item {",
      "    on_true minecraft:item/trident_throwing",
      "    on_false minecraft:item/trident",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    const unsupported = result.diagnostics.filter(
      diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"
    );
    assert.strictEqual(unsupported.length, 2);
    for (const diagnostic of unsupported) {
      assert.match(diagnostic.message, /cannot losslessly represent.*using_item.*pulling/);
      assert.strictEqual(
        source.slice(diagnostic.range.start, diagnostic.range.end),
        "minecraft:using_item"
      );
    }
    assert.deepStrictEqual(result.units, []);
  });

  it("reports unsupported item models in the legacy item backend", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item bundle {",
      "  selected_item",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"));
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects component conditions in the legacy item backend", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
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

  it("switches from the legacy backend at pack format 44", () => {
    const legacy = compileSourceWithUncheckedExterns([
      "target java format [43, 0]",
      "item wand { model minecraft:item/wand }"
    ]);
    const modern = compileSourceWithUncheckedExterns([
      "target java format [44, 0]",
      "item wand { model minecraft:item/wand }"
    ]);

    expectNoDiagnostics(legacy);
    expectNoDiagnostics(modern);
    assert.strictEqual(legacy.units[0].kind, "model");
    assert.strictEqual(legacy.units[0].outputPath, "assets/minecraft/models/item/wand.json");
    assert.strictEqual(modern.units[0].kind, "item");
    assert.strictEqual(modern.units[0].outputPath, "assets/minecraft/items/wand.json");
  });

  it("validates raw item-model fields before legacy lowering", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item wand {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/wand,",
      "      weight: 2",
      "    }",
      "  }",
      "}"
    ]);

    const unexpected = result.diagnostics.filter(
      diagnostic => diagnostic.code === "rsgl.unexpectedItemModelField"
    );
    assert.strictEqual(unexpected.length, 1);
    assert.match(unexpected[0].message, /weight/);
    assert.ok(!result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unsupportedItemModelType"
      || diagnostic.code === "rsgl.unsupportedItemFeature"
    ));
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: { layer0: "minecraft:item/wand" }
    });
    const weightRange = result.units[0].sourceMap.mappings.find(
      mapping => mapping.generatedPath === "/model/weight"
    )?.sourceRange;
    assert.deepStrictEqual(unexpected[0].range, weightRange);
  });

  it("rejects every legacy property option that cannot be represented", () => {
    const source = [
      "target java format 43",
      "item range_index {",
      "  range property minecraft:custom_model_data index 1 scale 2 {",
      "    entry 1 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item select_index {",
      "  select property minecraft:custom_model_data index 1 {",
      "    case 1 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item raw_damage {",
      "  range property minecraft:damage normalize false {",
      "    entry 1 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item zero_scale {",
      "  range property minecraft:custom_model_data scale 0 {",
      "    entry 1 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item compass {",
      "  range property minecraft:compass target spawn wobble false {",
      "    entry 0.5 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item clock_source {",
      "  range property minecraft:time source daytime wobble false {",
      "    entry 0.5 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}",
      "item clock_natural {",
      "  range property minecraft:time natural_only false {",
      "    entry 0.5 => minecraft:item/one",
      "    fallback minecraft:item/base",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    const unsupported = result.diagnostics.filter(
      diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"
    );
    assert.strictEqual(unsupported.length, 9);
    assert.deepStrictEqual(result.units, []);
    const expectedSourceValue = (message: string): string => {
      if (message.includes("'index'")) {
        return "1";
      }
      if (message.includes("'normalize'")) {
        return "false";
      }
      if (message.includes("'scale'")) {
        return "0";
      }
      if (message.includes("'target'")) {
        return "spawn";
      }
      if (message.includes("'source'")) {
        return "daytime";
      }
      if (message.includes("'natural_only'")) {
        return "false";
      }
      if (message.includes("'wobble'")) {
        return "false";
      }
      assert.fail("Unexpected legacy option diagnostic: " + message);
    };
    for (const diagnostic of unsupported) {
      assert.strictEqual(
        source.slice(diagnostic.range.start, diagnostic.range.end),
        expectedSourceValue(diagnostic.message)
      );
    }
  });

  it("rejects every lossy legacy item-model field", () => {
    const result = compileSourceWithUncheckedExterns([
      "target java format 43",
      "item tinted {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/tinted,",
      "      tints: [{ type: minecraft:constant, value: -1 }]",
      "    }",
      "  }",
      "}",
      "item transformed {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/transformed,",
      "      transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]",
      "    }",
      "  }",
      "}",
      "item flagged {",
      "  merge {",
      "    oversized_in_gui: true,",
      "    model: { type: minecraft:model, model: minecraft:item/flagged }",
      "  }",
      "}"
    ]);

    const unsupported = result.diagnostics.filter(
      diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"
    );
    assert.strictEqual(unsupported.length, 3);
    assert.ok(unsupported.some(diagnostic => diagnostic.message.includes("'tints'")));
    assert.ok(unsupported.some(diagnostic => diagnostic.message.includes("'transformation'")));
    assert.ok(unsupported.some(diagnostic => diagnostic.message.includes("'oversized_in_gui'")));
    assert.ok(!result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unsupportedItemModelType"
      || diagnostic.code === "rsgl.unsupportedItemFeature"
      || diagnostic.code === "rsgl.unsupportedItemTransformation"
    ));
    assert.deepStrictEqual(result.units, []);
  });
});
