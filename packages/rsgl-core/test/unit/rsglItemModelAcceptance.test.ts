import * as assert from "node:assert/strict";
import type { ResourceUnit } from "../../src/compiler";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits,
  unitByPath
} from "./helpers/compile";

describe("RSGL item-model large-sample acceptance", () => {
  it("preserves all 45 potion cases, their order, and the signed fallback tint", () => {
    const source = potionSource();
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const model = objectField(unitByPath(result, "items/potion.json").content, "model");
    assert.strictEqual(model.type, "minecraft:select");
    assert.strictEqual(model.property, "minecraft:component");
    assert.strictEqual(model.component, "minecraft:potion_contents");

    const cases = arrayField(model, "cases").map(asObject);
    assert.strictEqual(cases.length, 45);
    assert.deepStrictEqual(
      cases.map(item => ({
        when: item.when,
        model: objectField(item, "model").model
      })),
      POTION_ROWS.map(([id, stem]) => ({
        when: [{ potion: `minecraft:${id}` }],
        model: `minecraft:item/potions/normal/${stem}`
      }))
    );
    assert.deepStrictEqual(model.fallback, {
      type: "minecraft:model",
      model: "minecraft:item/potion",
      tints: [{ type: "minecraft:potion", default: -13083194 }]
    });
  });

  it("right-folds 43 presence rules and 128 level rules within exact budget and depth", () => {
    const rows = enchantmentRows();
    const source = enchantedBookSource(rows);
    const exact = compileSourceWithUncheckedExterns(source.split("\n"), {
      maxEvaluationItems: 171,
      maxItemModelDepth: 46
    });

    expectNoDiagnostics(exact);
    let outer = objectField(unitByPath(exact, "items/enchanted_book.json").content, "model");
    for (const row of rows) {
      assert.strictEqual(outer.type, "minecraft:condition");
      assert.strictEqual(outer.property, "minecraft:component");
      assert.strictEqual(outer.predicate, "stored_enchantments");
      assert.deepStrictEqual(outer.value, [{ enchantments: `minecraft:${row.id}` }]);

      let levels = objectField(outer, "on_true");
      for (const level of row.levels) {
        assert.strictEqual(levels.type, "minecraft:condition");
        assert.strictEqual(levels.property, "minecraft:component");
        assert.strictEqual(levels.predicate, "stored_enchantments");
        assert.deepStrictEqual(levels.value, [{
          enchantments: `minecraft:${row.id}`,
          levels: level.value
        }]);
        assert.deepStrictEqual(levels.on_true, {
          type: "minecraft:model",
          model: `minecraft:${level.model}`
        });
        levels = objectField(levels, "on_false");
      }
      assert.deepStrictEqual(levels, {
        type: "minecraft:model",
        model: `minecraft:${row.overflow}`
      });
      // The level-chain overflow remains inside on_true, so a matched
      // enchantment never falls through to a later outer enchantment.
      outer = objectField(outer, "on_false");
    }
    assert.deepStrictEqual(outer, {
      type: "minecraft:model",
      model: "minecraft:item/enchanted_book"
    });

    assert.deepStrictEqual(itemModelStats(
      objectField(unitByPath(exact, "items/enchanted_book.json").content, "model")
    ), {
      conditions: 171,
      modelLeaves: 172,
      maxDepth: 46
    });

    const overBudget = compileSourceWithUncheckedExterns(source.split("\n"), {
      maxEvaluationItems: 170,
      maxItemModelDepth: 46
    });
    assert.ok(overBudget.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.collectionExpansionLimit"
    ));

    const overDepth = compileSourceWithUncheckedExterns(source.split("\n"), {
      maxEvaluationItems: 171,
      maxItemModelDepth: 45
    });
    assert.ok(overDepth.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.itemModelDepthExceeded"
    ));
  });

  it("expands one trident decision template three times and satisfies the 15-leaf matrix", () => {
    const source = tridentSource();
    assert.strictEqual(source.match(/template tridentVariantItemModel/g)?.length, 1);
    assert.strictEqual(source.match(/use tridentVariantItemModel/g)?.length, 3);

    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    expectNoDiagnostics(result);
    const model = objectField(unitByPath(result, "items/trident.json").content, "model");
    const contexts = [
      { displayContext: "gui", usingItem: false, suffix: "", fallback: "minecraft:item/trident" },
      {
        displayContext: "firstperson_righthand",
        usingItem: false,
        suffix: "_in_hand",
        fallback: "minecraft:item/trident/in_hand"
      },
      {
        displayContext: "firstperson_righthand",
        usingItem: true,
        suffix: "_throwing",
        fallback: "minecraft:item/trident/throwing"
      }
    ] as const;
    const enchantmentCases = [
      { enchantments: ["channeling", "loyalty", "riptide"], stem: "cl" },
      { enchantments: ["channeling", "riptide"], stem: "channeling" },
      { enchantments: ["loyalty", "riptide"], stem: "loyalty" },
      { enchantments: ["riptide"], stem: "riptide" },
      { enchantments: [], stem: undefined }
    ] as const;

    const matrix = contexts.flatMap(context => enchantmentCases.map(enchantmentCase => ({
      context,
      enchantmentCase
    })));
    assert.strictEqual(matrix.length, 15);
    for (const { context, enchantmentCase } of matrix) {
      const actual = resolveItemModel(model, {
        displayContext: context.displayContext,
        usingItem: context.usingItem,
        enchantments: new Set(enchantmentCase.enchantments)
      });
      const expected = enchantmentCase.stem
        ? `minecraft:item/trident/${enchantmentCase.stem}${context.suffix}`
        : context.fallback;
      assert.strictEqual(actual, expected);
    }
  });

  it("self-maps 81 item resources through an ordinary top-level loop", () => {
    const ids = Array.from({ length: 81 }, (_, index) =>
      `mob_${String(index).padStart(2, "0")}_spawn_egg`
    );
    const source = [
      "let eggs = [",
      ...ids.map(id => `  minecraft:${id},`),
      "]",
      "for egg in eggs {",
      "  item egg {",
      "    model `minecraft:item/${resource_path(egg)}`",
      "  }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const units = generatedResourceUnits(result);
    assert.strictEqual(units.length, 81);
    assert.deepStrictEqual(
      units.map(unit => unit.outputPath),
      ids.map(id => `assets/minecraft/items/${id}.json`)
    );
    for (const id of ids) {
      assert.deepStrictEqual(unitByPath(result, `items/${id}.json`).content, {
        model: { type: "minecraft:model", model: `minecraft:item/${id}` }
      });
    }
  });

  it("keeps table-driven case, when, model, tint, and property-option provenance", () => {
    const source = provenanceSource();
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const selectUnit = unitByPath(result, "items/table_cases.json");
    const firstMatchUnit = unitByPath(result, "items/table_whens.json");

    assertPublicMapping(selectUnit, source, "/model/cases/0", "case row.when => row.model");
    assertPublicMapping(selectUnit, source, "/model/cases/0/when", "row.when");
    assertPublicMapping(selectUnit, source, "/model/cases/0/model/model", "row.model");
    assertPublicMapping(selectUnit, source, "/model/cases/0/model/tints", "row.tints");
    assertPublicMapping(firstMatchUnit, source, "/model", "when property row.property");
    assertPublicMapping(firstMatchUnit, source, "/model/property", "row.property");
    assertPublicMapping(firstMatchUnit, source, "/model/predicate", "row.predicate");
    assertPublicMapping(firstMatchUnit, source, "/model/value", "row.conditionValue");

    assertOrigin(selectUnit, source, "/model/cases/0/when", "[{ potion: minecraft:mundane }]");
    assertOrigin(selectUnit, source, "/model/cases/1/when", "[{ potion: minecraft:thick }]");
    assertOrigin(selectUnit, source, "/model/cases/0/model/model", "minecraft:item/potions/normal/mundane");
    assertOrigin(selectUnit, source, "/model/cases/1/model/model", "minecraft:item/potions/normal/thick");
    assertOrigin(selectUnit, source, "/model/cases/0/model/tints/0/value", "101");
    assertOrigin(selectUnit, source, "/model/cases/1/model/tints/0/value", "202");
    assertOrigin(firstMatchUnit, source, "/model/property", "minecraft:component");
    assertOrigin(firstMatchUnit, source, "/model/predicate", "\"stored_enchantments\"");
    assertOrigin(
      firstMatchUnit,
      source,
      "/model/value",
      "[{ enchantments: minecraft:aqua_affinity }]"
    );

    assertObservation(
      selectUnit,
      source,
      "/model/cases/0/model/model",
      "minecraft:item/potions/normal/mundane"
    );
    assertObservation(
      selectUnit,
      source,
      "/model/cases/1/model/model",
      "minecraft:item/potions/normal/thick"
    );

    const invalidSource = source.replace("value: 202", "value: 2147483648");
    const invalid = compileSourceWithUncheckedExterns(invalidSource.split("\n"));
    const tintDiagnostic = invalid.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintColor"
    );
    assert.ok(tintDiagnostic);
    assert.strictEqual(
      invalidSource.slice(tintDiagnostic.range.start, tintDiagnostic.range.end),
      "2147483648"
    );
  });
});

const POTION_ROWS = [
  ["mundane", "mundane"],
  ["thick", "thick"],
  ["awkward", "awkward"],
  ["night_vision", "night_vision"],
  ["long_night_vision", "night_vision_long"],
  ["invisibility", "invisibility"],
  ["long_invisibility", "invisibility_long"],
  ["leaping", "jump_boost"],
  ["long_leaping", "jump_boost_long"],
  ["strong_leaping", "jump_boost_strong"],
  ["fire_resistance", "fire_resistance"],
  ["long_fire_resistance", "fire_resistance_long"],
  ["swiftness", "speed"],
  ["long_swiftness", "speed_long"],
  ["strong_swiftness", "speed_strong"],
  ["slowness", "slowness"],
  ["long_slowness", "slowness_long"],
  ["strong_slowness", "slowness_strong"],
  ["water_breathing", "water_breathing"],
  ["long_water_breathing", "water_breathing_long"],
  ["healing", "instant_health"],
  ["strong_healing", "instant_health_strong"],
  ["harming", "instant_damage"],
  ["strong_harming", "instant_damage_strong"],
  ["poison", "poison"],
  ["long_poison", "poison_long"],
  ["strong_poison", "poison_strong"],
  ["regeneration", "regeneration"],
  ["long_regeneration", "regeneration_long"],
  ["strong_regeneration", "regeneration_strong"],
  ["strength", "strength"],
  ["long_strength", "strength_long"],
  ["strong_strength", "strength_strong"],
  ["weakness", "weakness"],
  ["long_weakness", "weakness_long"],
  ["luck", "luck"],
  ["turtle_master", "turtle_master"],
  ["long_turtle_master", "turtle_master_long"],
  ["strong_turtle_master", "turtle_master_strong"],
  ["slow_falling", "slow_falling"],
  ["long_slow_falling", "slow_falling_long"],
  ["wind_charged", "wind_charged"],
  ["weaving", "weaving"],
  ["oozing", "oozing"],
  ["infested", "infested"]
] as const;

interface EnchantmentRow {
  readonly id: string;
  readonly levels: readonly { readonly value: number; readonly model: string }[];
  readonly overflow: string;
}

function potionSource(): string {
  return [
    "let potions = [",
    ...POTION_ROWS.map(([id, stem]) =>
      `  { id: minecraft:${id}, stem: "${stem}" },`
    ),
    "]",
    "item potion {",
    "  select property minecraft:component component minecraft:potion_contents {",
    "    for potion in potions {",
    "      case [{ potion: potion.id }] => `minecraft:item/potions/normal/${potion.stem}`",
    "    }",
    "    fallback minecraft:item/potion with {",
    "      tints: [{ type: minecraft:potion, default: -13083194 }]",
    "    }",
    "  }",
    "}"
  ].join("\n");
}

function enchantmentRows(): EnchantmentRow[] {
  const levelCounts = [
    ...Array<number>(9).fill(1),
    ...Array<number>(4).fill(2),
    ...Array<number>(15).fill(3),
    ...Array<number>(7).fill(5),
    ...Array<number>(7).fill(4),
    3
  ];
  assert.strictEqual(levelCounts.length, 43);
  assert.strictEqual(levelCounts.reduce((sum, value) => sum + value, 0), 128);
  return levelCounts.map((levelCount, index) => {
    const stem = index === 42 ? "lunge" : `enchantment_${String(index).padStart(2, "0")}`;
    return {
      id: stem,
      levels: Array.from({ length: levelCount }, (_, levelIndex) => ({
        value: levelIndex + 1,
        model: `item/enchanted_book/${stem}_${levelIndex + 1}`
      })),
      overflow: `item/enchanted_book/${stem}_over`
    };
  });
}

function enchantedBookSource(rows: readonly EnchantmentRow[]): string {
  const tableLines = rows.flatMap(row => [
    "  {",
    `    id: minecraft:${row.id},`,
    "    levels: [",
    ...row.levels.map(level =>
      `      { value: ${level.value}, model: minecraft:${level.model} },`
    ),
    "    ],",
    `    overflow: minecraft:${row.overflow},`,
    "  },"
  ]);
  return [
    "let enchantments = [",
    ...tableLines,
    "]",
    "template enchantmentLevels(enchantment: Json) -> item_model {",
    "  let levels = enchantment.levels",
    "  first_match {",
    "    for level in levels {",
    "      when property minecraft:component predicate \"stored_enchantments\" value [{ enchantments: enchantment.id, levels: level.value }] => level.model",
    "    }",
    "    fallback enchantment.overflow",
    "  }",
    "}",
    "item enchanted_book {",
    "  first_match {",
    "    for enchantment in enchantments {",
    "      when property minecraft:component predicate \"stored_enchantments\" value [{ enchantments: enchantment.id }] => use enchantmentLevels(enchantment: enchantment)",
    "    }",
    "    fallback minecraft:item/enchanted_book",
    "  }",
    "}"
  ].join("\n");
}

function tridentSource(): string {
  return [
    "template tridentVariantItemModel(suffix: String, fallbackModel: ModelId) -> item_model {",
    "  first_match {",
    "    when property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:channeling }] => condition property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:loyalty }] {",
    "      on_true `minecraft:item/trident/cl${suffix}`",
    "      on_false `minecraft:item/trident/channeling${suffix}`",
    "    }",
    "    when property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:loyalty }] => `minecraft:item/trident/loyalty${suffix}`",
    "    when property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:riptide }] => `minecraft:item/trident/riptide${suffix}`",
    "    fallback fallbackModel",
    "  }",
    "}",
    "item trident {",
    "  select property minecraft:display_context {",
    "    case [\"thirdperson_righthand\", \"thirdperson_lefthand\", \"firstperson_righthand\", \"firstperson_lefthand\"] => condition property minecraft:using_item {",
    "      on_true use tridentVariantItemModel(suffix: \"_throwing\", fallbackModel: minecraft:item/trident/throwing)",
    "      on_false use tridentVariantItemModel(suffix: \"_in_hand\", fallbackModel: minecraft:item/trident/in_hand)",
    "    }",
    "    fallback use tridentVariantItemModel(suffix: \"\", fallbackModel: minecraft:item/trident)",
    "  }",
    "}"
  ].join("\n");
}

function provenanceSource(): string {
  return [
    "let rows = [",
    "  { property: minecraft:component, predicate: \"stored_enchantments\", conditionValue: [{ enchantments: minecraft:aqua_affinity }], when: [{ potion: minecraft:mundane }], model: minecraft:item/potions/normal/mundane, tints: [{ type: minecraft:constant, value: 101 }] },",
    "  { property: minecraft:component, predicate: \"stored_enchantments\", conditionValue: [{ enchantments: minecraft:binding_curse }], when: [{ potion: minecraft:thick }], model: minecraft:item/potions/normal/thick, tints: [{ type: minecraft:constant, value: 202 }] },",
    "]",
    "item table_cases {",
    "  select property minecraft:component component minecraft:potion_contents {",
    "    for row in rows {",
    "      case row.when => row.model with { tints: row.tints }",
    "    }",
    "    fallback minecraft:item/potion",
    "  }",
    "}",
    "item table_whens {",
    "  first_match {",
    "    for row in rows {",
    "      when property row.property predicate row.predicate value row.conditionValue => row.model",
    "    }",
    "    fallback minecraft:item/enchanted_book",
    "  }",
    "}"
  ].join("\n");
}

function itemModelStats(root: Record<string, unknown>): {
  conditions: number;
  modelLeaves: number;
  maxDepth: number;
} {
  let conditions = 0;
  let modelLeaves = 0;
  let maxDepth = 0;
  const visit = (node: Record<string, unknown>, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (node.type === "minecraft:model") {
      modelLeaves++;
      return;
    }
    if (node.type === "minecraft:condition") {
      conditions++;
      visit(objectField(node, "on_true"), depth + 1);
      visit(objectField(node, "on_false"), depth + 1);
    }
  };
  visit(root, 0);
  return { conditions, modelLeaves, maxDepth };
}

interface ItemModelState {
  readonly displayContext: string;
  readonly usingItem: boolean;
  readonly enchantments: ReadonlySet<string>;
}

function resolveItemModel(root: Record<string, unknown>, state: ItemModelState): string {
  let node = root;
  for (;;) {
    if (node.type === "minecraft:model") {
      const model = node.model;
      assert.strictEqual(typeof model, "string");
      if (typeof model !== "string") {
        throw new Error("Expected a model leaf id.");
      }
      return model;
    }
    if (node.type === "minecraft:select") {
      const matching = arrayField(node, "cases").map(asObject).find(item => {
        const when = item.when;
        return Array.isArray(when)
          ? when.includes(state.displayContext)
          : when === state.displayContext;
      });
      node = asObject(matching?.model ?? node.fallback);
      continue;
    }
    assert.strictEqual(node.type, "minecraft:condition");
    let matches: boolean;
    if (node.property === "minecraft:using_item") {
      matches = state.usingItem;
    } else {
      assert.strictEqual(node.property, "minecraft:component");
      const value = arrayField(node, "value");
      const predicate = asObject(value[0]).enchantments;
      assert.strictEqual(typeof predicate, "string");
      if (typeof predicate !== "string") {
        throw new Error("Expected an enchantment predicate id.");
      }
      matches = state.enchantments.has(predicate.replace(/^minecraft:/, ""));
    }
    node = objectField(node, matches ? "on_true" : "on_false");
  }
}

function assertPublicMapping(
  unit: ResourceUnit,
  source: string,
  generatedPath: string,
  expectedSource: string
): void {
  const mappings = unit.sourceMap.mappings.filter(mapping =>
    mapping.generatedPath === generatedPath
  );
  assert.ok(mappings.length > 0, `Missing public source mapping for ${generatedPath}`);
  assert.ok(mappings.some(mapping =>
    source.slice(mapping.sourceRange.start, mapping.sourceRange.end).includes(expectedSource)
  ), `No ${generatedPath} mapping points at '${expectedSource}'.`);
}

function assertOrigin(
  unit: ResourceUnit,
  source: string,
  generatedPath: string,
  expectedSource: string
): void {
  const origins = unit.validation?.referenceOrigins?.filter(origin =>
    origin.generatedPath === generatedPath
  ) ?? [];
  assert.ok(origins.length > 0, `Missing validation provenance for ${generatedPath}`);
  assert.ok(origins.some(origin =>
    source.slice(origin.sourceRange.start, origin.sourceRange.end) === expectedSource
  ), `No ${generatedPath} provenance points at '${expectedSource}'.`);
}

function assertObservation(
  unit: ResourceUnit,
  source: string,
  generatedPath: string,
  expectedSource: string
): void {
  const observations = unit.validation?.resourceValueObservations?.filter(observation =>
    observation.generatedPath === generatedPath
  ) ?? [];
  assert.ok(observations.length > 0, `Missing resource observation for ${generatedPath}`);
  assert.ok(observations.some(observation =>
    source.slice(observation.range.start, observation.range.end) === expectedSource
  ), `No ${generatedPath} observation points at '${expectedSource}'.`);
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  return asObject(asObject(value)[key]);
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = asObject(value)[key];
  assert.ok(Array.isArray(field));
  return field;
}
