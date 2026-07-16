import * as assert from "node:assert";
import {
  compileSourceWithUncheckedExterns,
  expectDiagnosticCodes,
  expectNoDiagnostics
} from "./helpers/compile";

describe("RSGL item model fragments", () => {
  it("lowers stdlib range frames with lambda model mapping", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { rangeFrames } from \"rsgl:conventions/item_definitions.rsgl\"",
      "use rangeFrames(",
      "  id: compass,",
      "  property: minecraft:custom_model_data,",
      "  values: 0..2,",
      "  model: frame => `minecraft:item/compass_${pad(frame, 2)}`,",
      "  fallback: minecraft:item/compass_00",
      ")"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.filter(unit => !unit.external).map(unit => unit.outputPath), [
      "assets/minecraft/items/compass.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:custom_model_data",
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } },
          { threshold: 2, model: { type: "minecraft:model", model: "minecraft:item/compass_02" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass_00"
        }
      }
    });
  });

  it("lowers item range and select statements", () => {
    const result = compileSourceWithUncheckedExterns([
      "item compass {",
      "  range property minecraft:compass target spawn wobble true {",
      "    frames 0..2 model `minecraft:item/compass_${pad(index, 2)}`",
      "    fallback minecraft:item/compass_00",
      "  }",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents component minecraft:potion_contents {",
      "    case \"minecraft:healing\" => minecraft:item/potion_healing",
      "    case \"minecraft:strong_healing\" => minecraft:item/potion_strong_healing",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("compass.json"))?.content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:compass",
        target: "spawn",
        wobble: true,
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } },
          { threshold: 2, model: { type: "minecraft:model", model: "minecraft:item/compass_02" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass_00"
        }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("potion.json"))?.content, {
      model: {
        type: "minecraft:select",
        property: "minecraft:potion_contents",
        component: "minecraft:potion_contents",
        cases: [
          { when: "minecraft:healing", model: { type: "minecraft:model", model: "minecraft:item/potion_healing" } },
          { when: "minecraft:strong_healing", model: { type: "minecraft:model", model: "minecraft:item/potion_strong_healing" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/potion"
        }
      }
    });
  });

  it("lowers items emitted by user templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "template compassItem(frames: Json = 0..1) {",
      "  item compass {",
      "    range property minecraft:compass target spawn {",
      "      frames frames model `minecraft:item/compass_${pad(index, 2)}`",
      "      fallback minecraft:item/compass_00",
      "    }",
      "  }",
      "}",
      "use compassItem()"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:compass",
        target: "spawn",
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass_00"
        }
      }
    });
  });

  it("lowers item condition and composite statements while validating raw model fields", () => {
    const result = compileSourceWithUncheckedExterns([
      "item bow {",
      "  condition property minecraft:using_item {",
      "    on_true minecraft:item/bow_pulling_0",
      "    on_false minecraft:item/bow",
      "  }",
      "}",
      "item layered {",
      "  composite {",
      "    model minecraft:item/base",
      "    model { model: minecraft:item/overlay, weight: 2 }",
      "  }",
      "}"
    ]);

    expectDiagnosticCodes(result, ["rsgl.unexpectedItemModelField"]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("bow.json"))?.content, {
      model: {
        type: "minecraft:condition",
        property: "minecraft:using_item",
        ["on_true"]: { type: "minecraft:model", model: "minecraft:item/bow_pulling_0" },
        ["on_false"]: { type: "minecraft:model", model: "minecraft:item/bow" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("layered.json"))?.content, {
      model: {
        type: "minecraft:composite",
        models: [
          { type: "minecraft:model", model: "minecraft:item/base" },
          { type: "minecraft:model", model: "minecraft:item/overlay", weight: 2 }
        ]
      }
    });
  });

  it("lowers item special, empty, and selected item statements", () => {
    const checkedResources: string[] = [];
    const result = compileSourceWithUncheckedExterns([
      "extern custom model minecraft:item/shield, minecraft:item/chest",
      "extern custom texture minecraft:entity/chest/christmas",
      "item shield {",
      "  special base minecraft:item/shield model { type: minecraft:shield }",
      "}",
      "item chest {",
      "  special base minecraft:item/chest model { type: minecraft:chest, texture: \"christmas\" }",
      "}",
      "item hidden {",
      "  empty",
      "}",
      "item bundle {",
      "  selected_item",
      "}"
    ], {
      externResourceExists: (_source, kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("shield.json"))?.content, {
      model: {
        type: "minecraft:special",
        base: "minecraft:item/shield",
        model: { type: "minecraft:shield" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("chest.json"))?.content, {
      model: {
        type: "minecraft:special",
        base: "minecraft:item/chest",
        model: { type: "minecraft:chest", texture: "minecraft:christmas" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("hidden.json"))?.content, {
      model: { type: "minecraft:empty" }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("bundle.json"))?.content, {
      model: { type: "minecraft:bundle/selected_item" }
    });
    assert.ok(checkedResources.includes("model:minecraft:item/shield"));
    assert.ok(checkedResources.includes("model:minecraft:item/chest"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/chest/christmas"));
  });
});
