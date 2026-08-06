import * as assert from "node:assert";
import {
  compileSourceWithUncheckedExterns,
  expectDiagnosticCodes,
  expectNoDiagnostics,
  unitByPath
} from "./helpers/compile";

describe("RSGL recursive item-model enhancements", () => {
  it("lowers recursive nodes, postfix options, owner control flow, and frame bindings", () => {
    const result = compileSourceWithUncheckedExterns([
      "template stateLeaf(suffix: String) -> item_model {",
      "  condition property minecraft:using_item {",
      "    on_true `minecraft:item/active_${suffix}`",
      "    on_false minecraft:item/idle",
      "  }",
      "}",
      "item recursive {",
      "  select property minecraft:display_context {",
      "    let leaf = minecraft:item/default",
      "    case \"gui\" => composite {",
      "      model minecraft:item/base with {",
      "        tints: [{ type: minecraft:constant, value: -1 }]",
      "      }",
      "      model range property minecraft:damage scale 0.5 {",
      "        entry 0 => empty {}",
      "        frames [2, 4] model use stateLeaf(suffix: `${index}_${frame}`)",
      "        entry 9 => selected_item {}",
      "        fallback leaf",
      "      }",
      "    }",
      "    fallback minecraft:item/fallback",
      "  } with {",
      "    transformation: { translation: [0, 0.1, 0] }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "items/recursive.json").content, {
      model: {
        type: "minecraft:select",
        property: "minecraft:display_context",
        cases: [{
          when: "gui",
          model: {
            type: "minecraft:composite",
            models: [
              {
                type: "minecraft:model",
                model: "minecraft:item/base",
                tints: [{ type: "minecraft:constant", value: -1 }]
              },
              {
                type: "minecraft:range_dispatch",
                property: "minecraft:damage",
                scale: 0.5,
                entries: [
                  { threshold: 0, model: { type: "minecraft:empty" } },
                  {
                    threshold: 2,
                    model: {
                      type: "minecraft:condition",
                      property: "minecraft:using_item",
                      on_true: { type: "minecraft:model", model: "minecraft:item/active_0_2" },
                      on_false: { type: "minecraft:model", model: "minecraft:item/idle" }
                    }
                  },
                  {
                    threshold: 4,
                    model: {
                      type: "minecraft:condition",
                      property: "minecraft:using_item",
                      on_true: { type: "minecraft:model", model: "minecraft:item/active_1_4" },
                      on_false: { type: "minecraft:model", model: "minecraft:item/idle" }
                    }
                  },
                  { threshold: 9, model: { type: "minecraft:bundle/selected_item" } }
                ],
                fallback: { type: "minecraft:model", model: "minecraft:item/default" }
              }
            ]
          }
        }],
        fallback: { type: "minecraft:model", model: "minecraft:item/fallback" },
        transformation: { translation: [0, 0.1, 0] }
      }
    });
  });

  it("right-folds first_match and supports item_model templates at root and nested slots", () => {
    const result = compileSourceWithUncheckedExterns([
      "template enchantmentLeaf(rows: List<Json>, fallbackModel: ModelId) -> item_model {",
      "  first_match {",
      "    for row in rows {",
      "      when property minecraft:component predicate \"enchantments\" value [{ enchantments: row.id }] => `minecraft:item/book/${row.stem}`",
      "    }",
      "    fallback fallbackModel",
      "  }",
      "}",
      "let rows = [",
      "  { id: minecraft:binding_curse, stem: \"curse_of_binding\" },",
      "  { id: minecraft:lunge, stem: \"lunge\" },",
      "]",
      "item root_use {",
      "  use enchantmentLeaf(rows: rows, fallbackModel: minecraft:item/book)",
      "}",
      "item nested_use {",
      "  composite {",
      "    model minecraft:item/base",
      "    model use enchantmentLeaf(rows: rows, fallbackModel: minecraft:item/book)",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const folded = {
      type: "minecraft:condition",
      property: "minecraft:component",
      predicate: "enchantments",
      value: [{ enchantments: "minecraft:binding_curse" }],
      on_true: { type: "minecraft:model", model: "minecraft:item/book/curse_of_binding" },
      on_false: {
        type: "minecraft:condition",
        property: "minecraft:component",
        predicate: "enchantments",
        value: [{ enchantments: "minecraft:lunge" }],
        on_true: { type: "minecraft:model", model: "minecraft:item/book/lunge" },
        on_false: { type: "minecraft:model", model: "minecraft:item/book" }
      }
    };
    assert.deepStrictEqual(unitByPath(result, "items/root_use.json").content, { model: folded });
    assert.deepStrictEqual(unitByPath(result, "items/nested_use.json").content, {
      model: {
        type: "minecraft:composite",
        models: [
          { type: "minecraft:model", model: "minecraft:item/base" },
          folded
        ]
      }
    });
  });

  it("keeps explicit entries and repeatable frames in source expansion order", () => {
    const result = compileSourceWithUncheckedExterns([
      "item ordered {",
      "  range property minecraft:custom_model_data {",
      "    frames [10, 11] model `minecraft:item/a_${index}_${frame}`",
      "    entry 5 => minecraft:item/manual",
      "    frames [\"x\", \"y\"] model `minecraft:item/b_${index}_${frame}`",
      "    fallback minecraft:item/fallback",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      (unitByPath(result, "items/ordered.json").content as { model: { entries: unknown[] } }).model.entries,
      [
        { threshold: 10, model: { type: "minecraft:model", model: "minecraft:item/a_0_10" } },
        { threshold: 11, model: { type: "minecraft:model", model: "minecraft:item/a_1_11" } },
        { threshold: 5, model: { type: "minecraft:model", model: "minecraft:item/manual" } },
        { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/b_0_x" } },
        { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/b_1_y" } }
      ]
    );
  });

  it("canonicalizes all root model spellings and keeps the first expanded producer", () => {
    const result = compileSourceWithUncheckedExterns([
      "item introduced { model minecraft:item/shared }",
      "item colon { model: minecraft:item/shared }",
      "item equals { model = minecraft:item/shared }",
      "item dynamic_colon { [\"model\"]: minecraft:item/shared }",
      "item dynamic_equals { let key = \"model\"\n  [key] = minecraft:item/shared }",
      "item conflict {",
      "  if true { model minecraft:item/first }",
      "  model: minecraft:item/ignored",
      "}"
    ]);

    expectDiagnosticCodes(result, ["rsgl.multipleItemModelProducers"]);
    const shared = { model: { type: "minecraft:model", model: "minecraft:item/shared" } };
    assert.deepStrictEqual(unitByPath(result, "items/introduced.json").content, shared);
    assert.deepStrictEqual(unitByPath(result, "items/colon.json").content, shared);
    assert.deepStrictEqual(unitByPath(result, "items/equals.json").content, shared);
    assert.deepStrictEqual(unitByPath(result, "items/dynamic_colon.json").content, shared);
    assert.deepStrictEqual(unitByPath(result, "items/dynamic_equals.json").content, shared);
    assert.deepStrictEqual(unitByPath(result, "items/conflict.json").content, {
      model: { type: "minecraft:model", model: "minecraft:item/first" }
    });
  });

  it("uses the shared shallow, deep, strict, upsert, and append merge semantics", () => {
    const result = compileSourceWithUncheckedExterns([
      "item shallow {",
      "  model minecraft:item/original with { tints: [{ type: minecraft:constant, value: 1 }] }",
      "  merge { model: { type: minecraft:empty } }",
      "}",
      "item deep {",
      "  model minecraft:item/deep with {",
      "    tints: [{ type: minecraft:constant, value: 1 }],",
      "    transformation: { translation: [0, 0, 0] },",
      "  }",
      "  merge deep {",
      "    model: {",
      "      tints: [{ type: minecraft:constant, value: 2 }],",
      "      transformation: { scale: [2, 2, 2] },",
      "    },",
      "  }",
      "}",
      "item strict {",
      "  model minecraft:item/strict with { transformation: { translation: [0, 0, 0] } }",
      "  merge strict { model: { transformation: { translation: [1, 2, 3] } } }",
      "}",
      "item upsert {",
      "  model minecraft:item/upsert",
      "  merge upsert { model: { transformation: { scale: [2, 2, 2] } } }",
      "}",
      "item append {",
      "  model minecraft:item/append with { tints: [{ type: minecraft:constant, value: 1 }] }",
      "  merge append { model: { tints: [{ type: minecraft:constant, value: 2 }] } }",
      "}",
      "item atomic_control {",
      "  merge { model: { type: minecraft:model, model: minecraft:item/base, tints: [{ type: minecraft:constant, value: 1 }] } }",
      "  if true { model minecraft:item/replacement }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "items/shallow.json").content, {
      model: { type: "minecraft:empty" }
    });
    assert.deepStrictEqual(unitByPath(result, "items/deep.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/deep",
        tints: [
          { type: "minecraft:constant", value: 1 },
          { type: "minecraft:constant", value: 2 }
        ],
        transformation: { translation: [0, 0, 0], scale: [2, 2, 2] }
      }
    });
    assert.deepStrictEqual(unitByPath(result, "items/strict.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/strict",
        transformation: { translation: [1, 2, 3] }
      }
    });
    assert.deepStrictEqual(unitByPath(result, "items/upsert.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/upsert",
        transformation: { scale: [2, 2, 2] }
      }
    });
    assert.deepStrictEqual(unitByPath(result, "items/append.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/append",
        tints: [
          { type: "minecraft:constant", value: 1 },
          { type: "minecraft:constant", value: 2 }
        ]
      }
    });
    assert.deepStrictEqual(unitByPath(result, "items/atomic_control.json").content, {
      model: { type: "minecraft:model", model: "minecraft:item/replacement" }
    });
  });

  it("reports missing roots, template cardinality, and expanded depth", () => {
    const missing = compileSourceWithUncheckedExterns(["item missing {}"]);
    expectDiagnosticCodes(missing, ["rsgl.compileMissingItemModel"]);

    const cardinality = compileSourceWithUncheckedExterns([
      "template none(flag: Boolean) -> item_model {",
      "  if flag { model minecraft:item/value }",
      "}",
      "template many() -> item_model {",
      "  model minecraft:item/one",
      "  model minecraft:item/two",
      "}",
      "item zero { use none(flag: false) }",
      "item two { use many() }"
    ]);
    assert.ok(cardinality.diagnostics.filter(item => item.code === "rsgl.itemModelTemplateCardinality").length === 2);

    const depth = compileSourceWithUncheckedExterns([
      "item too_deep {",
      "  condition property minecraft:using_item {",
      "    on_true condition property minecraft:using_item {",
      "      on_true condition property minecraft:using_item {",
      "        on_true condition property minecraft:using_item {",
      "          on_true minecraft:item/deep",
      "          on_false minecraft:item/deep",
      "        }",
      "        on_false minecraft:item/deep",
      "      }",
      "      on_false minecraft:item/deep",
      "    }",
      "    on_false minecraft:item/deep",
      "  }",
      "}"
    ], { maxItemModelDepth: 2 });
    assert.ok(depth.diagnostics.some(item => item.code === "rsgl.itemModelDepthExceeded"));
    assert.strictEqual(depth.diagnostics.some(item => item.code === "rsgl.compileMissingItemModel"), false);
  });

  it("counts selected template producers independently from lowering success", () => {
    const singleInvalid = compileSourceWithUncheckedExterns([
      "template invalid() -> item_model { let bad: Json = 42; model bad }",
      "item invalid_call { use invalid() }"
    ]);
    assert.ok(singleInvalid.diagnostics.some(item => item.code === "rsgl.invalidItemModel"));
    assert.strictEqual(
      singleInvalid.diagnostics.some(item => item.code === "rsgl.itemModelTemplateCardinality"),
      false
    );

    const mixed = compileSourceWithUncheckedExterns([
      "template mixed() -> item_model {",
      "  let bad: Json = 42",
      "  model minecraft:item/valid",
      "  model bad",
      "}",
      "item mixed_call { use mixed() }"
    ]);
    assert.ok(mixed.diagnostics.some(item => item.code === "rsgl.invalidItemModel"));
    assert.ok(mixed.diagnostics.some(item =>
      item.code === "rsgl.itemModelTemplateCardinality"
      && item.message.endsWith("this path produced 2.")
    ));

    const failedRootUse = compileSourceWithUncheckedExterns([
      "template none() -> item_model { if false { model minecraft:item/unselected } }",
      "item fallback_producer {",
      "  use none()",
      "  model minecraft:item/selected",
      "}"
    ]);
    assert.ok(failedRootUse.diagnostics.some(item =>
      item.code === "rsgl.itemModelTemplateCardinality"
    ));
    assert.strictEqual(failedRootUse.diagnostics.some(item =>
      item.code === "rsgl.multipleItemModelProducers"
    ), false);
    assert.deepStrictEqual(unitByPath(failedRootUse, "items/fallback_producer.json").content, {
      model: { type: "minecraft:model", model: "minecraft:item/selected" }
    });
  });

  it("charges literal owner loops and frames to the shared evaluation budget", () => {
    const loopSource = [
      "item loop_budget {",
      "  select property minecraft:display_context {",
      "    for row in [{ when: \"gui\", model: minecraft:item/gui }, { when: \"ground\", model: minecraft:item/ground }] {",
      "      case row.when => row.model",
      "    }",
      "    fallback minecraft:item/fallback",
      "  }",
      "}"
    ];
    expectNoDiagnostics(compileSourceWithUncheckedExterns(loopSource, { maxEvaluationItems: 2 }));
    const loopLimited = compileSourceWithUncheckedExterns(loopSource, { maxEvaluationItems: 1 });
    assert.ok(loopLimited.diagnostics.some(item =>
      item.code === "rsgl.collectionExpansionLimit"
      && item.message.includes("for expansion")
    ));

    const framesSource = [
      "item frames_budget {",
      "  range property minecraft:custom_model_data {",
      "    frames [1, 2] model `minecraft:item/frame_${index}`",
      "    fallback minecraft:item/fallback",
      "  }",
      "}"
    ];
    expectNoDiagnostics(compileSourceWithUncheckedExterns(framesSource, { maxEvaluationItems: 2 }));
    const framesLimited = compileSourceWithUncheckedExterns(framesSource, { maxEvaluationItems: 1 });
    assert.ok(framesLimited.diagnostics.some(item =>
      item.code === "rsgl.collectionExpansionLimit"
      && item.message.includes("/model/entries")
    ));
  });

  it("checks final raw, base, and merged model trees against maxItemModelDepth", () => {
    const condition = "{ type: minecraft:condition, property: minecraft:using_item, on_true: { type: minecraft:model, model: minecraft:item/true }, on_false: { type: minecraft:model, model: minecraft:item/false } }";
    const baseCondition = {
      type: "minecraft:condition",
      property: "minecraft:using_item",
      on_true: { type: "minecraft:model", model: "minecraft:item/true" },
      on_false: { type: "minecraft:model", model: "minecraft:item/false" }
    };
    const result = compileSourceWithUncheckedExterns([
      `item raw_depth { model ${condition} }`,
      "item base_depth { base \"./deep-base.json\" }",
      "item merge_depth {",
      "  model minecraft:item/original",
      `  merge { model: ${condition} }`,
      "}"
    ], {
      maxItemModelDepth: 0,
      baseDocumentLoader: {
        load(request) {
          const sourceRange = { start: 0, end: 1 };
          return {
            content: { model: baseCondition },
            sourceFile: request,
            sourceRange,
            sourceRanges: new Map([["", sourceRange]]),
            dependencies: []
          };
        }
      }
    });

    const diagnostics = result.diagnostics.filter(item => item.code === "rsgl.itemModelDepthExceeded");
    assert.strictEqual(diagnostics.length, 3);
    assert.ok(diagnostics.every(item => item.message.includes("/model/on_true")));
  });
});
