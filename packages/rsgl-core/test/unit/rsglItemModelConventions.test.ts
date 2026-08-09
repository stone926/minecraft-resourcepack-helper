import * as assert from "node:assert/strict";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits,
  unitByPath
} from "./helpers/compile";

describe("RSGL item-model stdlib conventions", () => {
  it("expands one caller-owned potion table for three item definitions", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { potionItem } from \"rsgl:conventions/item_definitions.rsgl\"",
      "let potions = [",
      "  { id: minecraft:mundane, stem: \"mundane\" },",
      "  { id: minecraft:long_night_vision, stem: \"night_vision_long\" }",
      "]",
      "use potionItem(id: minecraft:potion, folder: \"normal\", potions: potions)",
      "use potionItem(id: minecraft:splash_potion, folder: \"splash\", potions: potions)",
      "use potionItem(id: minecraft:lingering_potion, folder: \"lingering\", potions: potions)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      generatedResourceUnits(result).map(unit => unit.outputPath).sort(),
      [
        "assets/minecraft/items/lingering_potion.json",
        "assets/minecraft/items/potion.json",
        "assets/minecraft/items/splash_potion.json"
      ]
    );
    assert.deepStrictEqual(unitByPath(result, "items/potion.json").content, {
      model: {
        type: "minecraft:select",
        property: "minecraft:component",
        component: "minecraft:potion_contents",
        cases: [
          {
            when: [{ potion: "minecraft:mundane" }],
            model: { type: "minecraft:model", model: "minecraft:item/potions/normal/mundane" }
          },
          {
            when: [{ potion: "minecraft:long_night_vision" }],
            model: { type: "minecraft:model", model: "minecraft:item/potions/normal/night_vision_long" }
          }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/potion",
          tints: [{ type: "minecraft:potion", default: -13083194 }]
        }
      }
    });
  });

  it("preserves caller order in the two-level enchanted-book table", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { orderedEnchantedBookItemModel } from \"rsgl:conventions/item_definitions.rsgl\"",
      "let enchantments = [",
      "  {",
      "    id: minecraft:aqua_affinity,",
      "    levels: [{ value: 1, model: minecraft:item/enchanted_book/aqua_affinity }],",
      "    overflow: minecraft:item/enchanted_book/aqua_affinity_over",
      "  },",
      "  {",
      "    id: minecraft:binding_curse,",
      "    levels: [{ value: 1, model: minecraft:item/enchanted_book/curse_of_binding }],",
      "    overflow: minecraft:item/enchanted_book/curse_of_binding_over",
      "  }",
      "]",
      "item enchanted_book {",
      "  use orderedEnchantedBookItemModel(",
      "    enchantments: enchantments,",
      "    fallbackModel: minecraft:item/enchanted_book",
      "  )",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "items/enchanted_book.json").content, {
      model: {
        type: "minecraft:condition",
        property: "minecraft:component",
        predicate: "stored_enchantments",
        value: [{ enchantments: "minecraft:aqua_affinity" }],
        on_true: {
          type: "minecraft:condition",
          property: "minecraft:component",
          predicate: "stored_enchantments",
          value: [{ enchantments: "minecraft:aqua_affinity", levels: 1 }],
          on_true: {
            type: "minecraft:model",
            model: "minecraft:item/enchanted_book/aqua_affinity"
          },
          on_false: {
            type: "minecraft:model",
            model: "minecraft:item/enchanted_book/aqua_affinity_over"
          }
        },
        on_false: {
          type: "minecraft:condition",
          property: "minecraft:component",
          predicate: "stored_enchantments",
          value: [{ enchantments: "minecraft:binding_curse" }],
          on_true: {
            type: "minecraft:condition",
            property: "minecraft:component",
            predicate: "stored_enchantments",
            value: [{ enchantments: "minecraft:binding_curse", levels: 1 }],
            on_true: {
              type: "minecraft:model",
              model: "minecraft:item/enchanted_book/curse_of_binding"
            },
            on_false: {
              type: "minecraft:model",
              model: "minecraft:item/enchanted_book/curse_of_binding_over"
            }
          },
          on_false: {
            type: "minecraft:model",
            model: "minecraft:item/enchanted_book"
          }
        }
      }
    });
  });

  it("reuses one trident decision tree for all three suffix variants", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { tridentVariantItemModel } from \"rsgl:conventions/item_definitions.rsgl\"",
      "item trident {",
      "  select property minecraft:display_context {",
      "    case [",
      "      \"thirdperson_righthand\",",
      "      \"thirdperson_lefthand\",",
      "      \"firstperson_righthand\",",
      "      \"firstperson_lefthand\"",
      "    ] => condition property minecraft:using_item {",
      "      on_true use tridentVariantItemModel(",
      "        suffix: \"_throwing\",",
      "        fallbackModel: minecraft:item/trident/throwing",
      "      )",
      "      on_false use tridentVariantItemModel(",
      "        suffix: \"_in_hand\",",
      "        fallbackModel: minecraft:item/trident/in_hand",
      "      )",
      "    }",
      "    fallback use tridentVariantItemModel(",
      "      suffix: \"\",",
      "      fallbackModel: minecraft:item/trident",
      "    )",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const models: string[] = [];
    collectModelIds(unitByPath(result, "items/trident.json").content, models);
    assert.deepStrictEqual(models, [
      "minecraft:item/trident/cl_throwing",
      "minecraft:item/trident/channeling_throwing",
      "minecraft:item/trident/loyalty_throwing",
      "minecraft:item/trident/riptide_throwing",
      "minecraft:item/trident/throwing",
      "minecraft:item/trident/cl_in_hand",
      "minecraft:item/trident/channeling_in_hand",
      "minecraft:item/trident/loyalty_in_hand",
      "minecraft:item/trident/riptide_in_hand",
      "minecraft:item/trident/in_hand",
      "minecraft:item/trident/cl",
      "minecraft:item/trident/channeling",
      "minecraft:item/trident/loyalty",
      "minecraft:item/trident/riptide",
      "minecraft:item/trident"
    ]);
  });

  it("self-maps a caller-owned list and only tints an explicitly configured spawn egg", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { selfMappedItems, tintedSpawnEggItemModel } from \"rsgl:conventions/item_definitions.rsgl\"",
      "use selfMappedItems(ids: [",
      "  minecraft:allay_spawn_egg,",
      "  minecraft:armadillo_spawn_egg,",
      "  minecraft:axolotl_spawn_egg,",
      "])",
      "item custom_spawn_egg {",
      "  use tintedSpawnEggItemModel(",
      "    baseModel: minecraft:item/custom_spawn_egg,",
      "    baseColor: -6265536,",
      "    highlightColor: [1, 0.5, 0],",
      "  )",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      generatedResourceUnits(result).map(unit => unit.outputPath).sort(),
      [
        "assets/minecraft/items/allay_spawn_egg.json",
        "assets/minecraft/items/armadillo_spawn_egg.json",
        "assets/minecraft/items/axolotl_spawn_egg.json",
        "assets/minecraft/items/custom_spawn_egg.json"
      ]
    );
    assert.deepStrictEqual(unitByPath(result, "items/allay_spawn_egg.json").content, {
      model: { type: "minecraft:model", model: "minecraft:item/allay_spawn_egg" }
    });
    assert.deepStrictEqual(unitByPath(result, "items/custom_spawn_egg.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/custom_spawn_egg",
        tints: [
          { type: "minecraft:constant", value: -6265536 },
          { type: "minecraft:constant", value: [1, 0.5, 0] }
        ]
      }
    });
  });
});

function collectModelIds(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelIds(item, result);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const object = value as Record<string, unknown>;
  if (object.type === "minecraft:model" && typeof object.model === "string") {
    result.push(object.model);
  }
  for (const child of Object.values(object)) {
    collectModelIds(child, result);
  }
}
