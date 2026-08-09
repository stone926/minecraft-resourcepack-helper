import * as assert from "node:assert/strict";
import { canonicalizeAndValidateResourceUnits } from "../../src/compiler";
import { compileSource } from "./helpers/compile";
import { minimalItemUnit } from "./helpers/fixtures";

describe("RSGL item definition validation", () => {
  it("validates item model condition trees", () => {
    const result = compileSource([
      "extern custom model minecraft:**",
      "item broken_compass {",
      "  merge {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:compass,",
      "      entries: [",
      "        { threshold: 1, model: { type: minecraft:model, model: minecraft:item/missing_high } },",
      "        { threshold: 0, model: { type: minecraft:model, model: minecraft:item/missing_low } }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item empty_range_entries {",
      "  merge {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:count,",
      "      entries: []",
      "    }",
      "  }",
      "}",
      "item broken_select {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ model: { type: minecraft:model, model: minecraft:item/missing_case } }]",
      "    }",
      "  }",
      "}",
      "item broken_condition {",
      "  merge {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_true: { type: minecraft:model, model: minecraft:item/missing_true }",
      "    }",
      "  }",
      "}"
    ], {
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(!codes.includes("rsgl.unsortedItemRangeThresholds"));
    assert.ok(codes.includes("rsgl.emptyItemRangeEntries"));
    assert.ok(codes.includes("rsgl.itemModelMissingFallback"));
    assert.ok(codes.includes("rsgl.invalidItemSelectCase"));
    assert.ok(codes.includes("rsgl.invalidItemConditionBranch"));
    const brokenCompassUnit = result.units.find(unit => unit.outputPath.endsWith("broken_compass.json"));
    const brokenCompassModelRange = brokenCompassUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model")?.sourceRange;
    const missingRangeFallback = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.itemModelMissingFallback" && diagnostic.message.includes("range_dispatch")
    );
    assert.deepStrictEqual(missingRangeFallback?.range, brokenCompassModelRange);
    const emptyEntriesUnit = result.units.find(unit => unit.outputPath.endsWith("empty_range_entries.json"));
    const emptyEntriesRange = emptyEntriesUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/entries")?.sourceRange;
    const emptyEntriesDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.emptyItemRangeEntries");
    assert.deepStrictEqual(emptyEntriesDiagnostic?.range, emptyEntriesRange);
    const brokenSelectUnit = result.units.find(unit => unit.outputPath.endsWith("broken_select.json"));
    const brokenSelectModelRange = brokenSelectUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model")?.sourceRange;
    const brokenSelectCaseRange = brokenSelectUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/cases/0")?.sourceRange;
    const brokenSelectCaseDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemSelectCase");
    assert.deepStrictEqual(brokenSelectCaseDiagnostic?.range, brokenSelectCaseRange);
    const missingSelectFallback = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.itemModelMissingFallback" && diagnostic.message.includes("select")
    );
    assert.deepStrictEqual(missingSelectFallback?.range, brokenSelectModelRange);
    const brokenConditionUnit = result.units.find(unit => unit.outputPath.endsWith("broken_condition.json"));
    const brokenConditionModelRange = brokenConditionUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model")?.sourceRange;
    const missingFalseDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.invalidItemConditionBranch" && diagnostic.message.includes("on_false")
    );
    assert.deepStrictEqual(missingFalseDiagnostic?.range, brokenConditionModelRange);
  });

  it("validates item composite and terminal model types", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom model minecraft:**",
      "item composite_with_missing_child {",
      "  merge {",
      "    model: {",
      "      type: minecraft:composite,",
      "      models: [",
      "        { type: minecraft:model, model: minecraft:item/missing_child },",
      "        { type: minecraft:empty },",
      "        { type: minecraft:bundle/selected_item }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item invalid_composite_models {",
      "  merge {",
      "    model: { type: minecraft:composite, models: \"bad\" }",
      "  }",
      "}",
      "item invalid_composite_child {",
      "  merge {",
      "    model: { type: minecraft:composite, models: [1] }",
      "  }",
      "}",
      "item unknown_model_type {",
      "  merge {",
      "    model: { type: minecraft:unknown }",
      "  }",
      "}",
      "item invalid_model_reference {",
      "  merge {",
      "    model: { type: minecraft:model, model: 1 }",
      "  }",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.invalidItemCompositeModels"));
    assert.ok(codes.includes("rsgl.invalidItemCompositeModel"));
    assert.ok(codes.includes("rsgl.invalidItemModelType"));
    assert.ok(codes.includes("rsgl.invalidItemModelReference"));
    assert.ok(checkedResources.includes("model:minecraft:item/missing_child"));
    const compositeUnit = result.units.find(unit => unit.outputPath.endsWith("composite_with_missing_child.json"));
    const missingChildRange = compositeUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/models/0/model")?.sourceRange;
    const missingChildDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.modelNotFound" && diagnostic.message.includes("missing_child")
    );
    assert.deepStrictEqual(missingChildDiagnostic?.range, missingChildRange);
    const invalidCompositeModelsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_composite_models.json"));
    const invalidCompositeModelsRange = invalidCompositeModelsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/models")?.sourceRange;
    const invalidCompositeModelsDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemCompositeModels");
    assert.deepStrictEqual(invalidCompositeModelsDiagnostic?.range, invalidCompositeModelsRange);
    const invalidCompositeChildUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_composite_child.json"));
    const invalidCompositeChildRange = invalidCompositeChildUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/models/0")?.sourceRange;
    const invalidCompositeChildDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemCompositeModel");
    assert.deepStrictEqual(invalidCompositeChildDiagnostic?.range, invalidCompositeChildRange);

    const emptyCompositeDiagnostics = canonicalizeAndValidateResourceUnits([minimalItemUnit({
      model: { type: "minecraft:composite", models: [] }
    })]);
    assert.ok(emptyCompositeDiagnostics.some(diagnostic => diagnostic.code === "rsgl.emptyItemCompositeModels"));
  });

  it("validates item special model resources and shape", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom model minecraft:**",
      "extern custom texture minecraft:**",
      "item broken_special {",
      "  merge {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/missing_base,",
      "      model: { type: minecraft:chest, texture: \"missing\" }",
      "    }",
      "  }",
      "}",
      "item invalid_special {",
      "  merge {",
      "    model: { type: minecraft:special, base: 1, model: \"not_an_object\" }",
      "  }",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialBase"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModel"));
    assert.ok(checkedResources.includes("model:minecraft:item/missing_base"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/chest/missing"));

    const brokenSpecialUnit = result.units.find(unit => unit.outputPath.endsWith("broken_special.json"));
    const invalidSpecialUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_special.json"));
    const missingBaseRange = brokenSpecialUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/base")?.sourceRange;
    const missingTextureRange = brokenSpecialUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model/texture")?.sourceRange;
    const invalidBaseRange = invalidSpecialUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/base")?.sourceRange;
    const invalidModelRange = invalidSpecialUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model")?.sourceRange;
    const missingBaseDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.modelNotFound" && diagnostic.message.includes("missing_base")
    );
    const missingTextureDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound" && diagnostic.message.includes("missing")
    );
    const invalidBaseDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemSpecialBase");
    const invalidModelDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemSpecialModel");
    assert.deepStrictEqual(missingBaseDiagnostic?.range, missingBaseRange);
    assert.deepStrictEqual(missingTextureDiagnostic?.range, missingTextureRange);
    assert.deepStrictEqual(invalidBaseDiagnostic?.range, invalidBaseRange);
    assert.deepStrictEqual(invalidModelDiagnostic?.range, invalidModelRange);
  });

  it("validates item special subtype fields and tints", () => {
    const result = compileSource([
      "item invalid_special_fields {",
      "  merge {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/base,",
      "      model: { type: minecraft:chest, chest_type: middle, openness: 2 }",
      "    }",
      "  }",
      "}",
      "item unknown_special_type {",
      "  merge {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:unknown } }",
      "  }",
      "}",
      "item invalid_special_texture {",
      "  merge {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:chest, texture: 1 } }",
      "  }",
      "}",
      "item invalid_tints {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [",
      "        { type: minecraft:constant, value: [1, 0.5] },",
      "        { type: minecraft:constant, value: -1 },",
      "        { type: minecraft:constant, value: 2147483648 },",
      "        { type: minecraft:grass, temperature: 2 },",
      "        { type: minecraft:grass, temperature: 0.5, downfall: 2 },",
      "        { type: minecraft:custom_model_data, default: 1, index: -1 },",
      "        { type: minecraft:unknown }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item invalid_nested_tints {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{",
      "        when: \"left\",",
      "        model: {",
      "          type: minecraft:model,",
      "          model: minecraft:item/base,",
      "          tints: [{ type: minecraft:constant, value: [1, 2, 0] }]",
      "        }",
      "      }],",
      "      fallback: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}"
    ], {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.missingItemSpecialModelField"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModelField"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModelType"));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidItemSpecialModelField" && diagnostic.message.includes("'texture'")));
    assert.ok(codes.includes("rsgl.invalidItemTintColor"));
    assert.ok(codes.includes("rsgl.missingItemTintField"));
    assert.ok(codes.includes("rsgl.invalidItemTintField"));
    assert.ok(codes.includes("rsgl.invalidItemTint"));
    const invalidTintsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_tints.json"));
    const tintValueRange = invalidTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/tints/0/value")?.sourceRange;
    const tintTemperatureRange = invalidTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/tints/3/temperature")?.sourceRange;
    const tintDownfallRange = invalidTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/tints/4/downfall")?.sourceRange;
    const tintIndexRange = invalidTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/tints/5/index")?.sourceRange;
    const invalidTintColor = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemTintColor");
    assert.deepStrictEqual(invalidTintColor?.range, tintValueRange);
    assert.notDeepStrictEqual(invalidTintColor?.range, invalidTintsUnit?.sourceMap.mappings[0].sourceRange);
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintField"
      && diagnostic.message.includes("'temperature'")
      && diagnostic.range.start === tintTemperatureRange?.start
      && diagnostic.range.end === tintTemperatureRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintField"
      && diagnostic.message.includes("'downfall'")
      && diagnostic.range.start === tintDownfallRange?.start
      && diagnostic.range.end === tintDownfallRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintField"
      && diagnostic.message.includes("'index'")
      && diagnostic.range.start === tintIndexRange?.start
      && diagnostic.range.end === tintIndexRange?.end
    ));
    const invalidNestedTintsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_nested_tints.json"));
    const nestedTintValueRange = invalidNestedTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/cases/0/model/tints/0/value")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintColor"
      && diagnostic.range.start === nestedTintValueRange?.start
      && diagnostic.range.end === nestedTintValueRange?.end
    ));
    const invalidSpecialFieldsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_special_fields.json"));
    const unknownSpecialTypeUnit = result.units.find(unit => unit.outputPath.endsWith("unknown_special_type.json"));
    const invalidSpecialTextureUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_special_texture.json"));
    const chestTypeRange = invalidSpecialFieldsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model/chest_type")?.sourceRange;
    const opennessRange = invalidSpecialFieldsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model/openness")?.sourceRange;
    const specialTypeRange = unknownSpecialTypeUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model/type")?.sourceRange;
    const specialTextureRange = invalidSpecialTextureUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/model/texture")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSpecialModelField"
      && diagnostic.message.includes("'chest_type'")
      && diagnostic.range.start === chestTypeRange?.start
      && diagnostic.range.end === chestTypeRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSpecialModelField"
      && diagnostic.message.includes("'openness'")
      && diagnostic.range.start === opennessRange?.start
      && diagnostic.range.end === opennessRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSpecialModelType"
      && diagnostic.range.start === specialTypeRange?.start
      && diagnostic.range.end === specialTypeRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSpecialModelField"
      && diagnostic.message.includes("'texture'")
      && diagnostic.range.start === specialTextureRange?.start
      && diagnostic.range.end === specialTextureRange?.end
    ));
  });

  it("validates item top-level fields and transformations", () => {
    const result = compileSource([
      "item invalid_top_level {",
      "  merge {",
      "    hand_animation_on_swap: \"yes\",",
      "    oversized_in_gui: 1,",
      "    swap_animation_scale: \"large\",",
      "    model: { type: minecraft:model, model: minecraft:item/base }",
      "  }",
      "}",
      "item invalid_matrix {",
      "  merge {",
      "    model: { type: minecraft:model, model: minecraft:item/base, transformation: [1, 0, 0] }",
      "  }",
      "}",
      "item invalid_transform_object {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      transformation: {",
      "        left_rotation: { angle: 45, axis: [0, 1] },",
      "        scale: [1, 1, 1],",
      "        translation: [0, 0, \"bad\"]",
      "      }",
      "    }",
      "  }",
      "}"
    ], {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidItemTopLevelField"));
    assert.ok(codes.includes("rsgl.invalidItemTransformation"));
    assert.ok(!codes.includes("rsgl.missingItemTransformationField"));
    const invalidTopLevelUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_top_level.json"));
    const handAnimationRange = invalidTopLevelUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/hand_animation_on_swap")?.sourceRange;
    const oversizedRange = invalidTopLevelUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/oversized_in_gui")?.sourceRange;
    const swapAnimationRange = invalidTopLevelUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/swap_animation_scale")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTopLevelField"
      && diagnostic.message.includes("'hand_animation_on_swap'")
      && diagnostic.range.start === handAnimationRange?.start
      && diagnostic.range.end === handAnimationRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTopLevelField"
      && diagnostic.message.includes("'oversized_in_gui'")
      && diagnostic.range.start === oversizedRange?.start
      && diagnostic.range.end === oversizedRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTopLevelField"
      && diagnostic.message.includes("'swap_animation_scale'")
      && diagnostic.range.start === swapAnimationRange?.start
      && diagnostic.range.end === swapAnimationRange?.end
    ));
    const invalidMatrixUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_matrix.json"));
    const matrixRange = invalidMatrixUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTransformation"
      && diagnostic.message.includes("matrix")
      && diagnostic.range.start === matrixRange?.start
      && diagnostic.range.end === matrixRange?.end
    ));
    const invalidTransformUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_transform_object.json"));
    const leftRotationRange = invalidTransformUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation/left_rotation")?.sourceRange;
    const translationRange = invalidTransformUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation/translation")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTransformation"
      && diagnostic.message.includes("'left_rotation'")
      && diagnostic.range.start === leftRotationRange?.start
      && diagnostic.range.end === leftRotationRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTransformation"
      && diagnostic.message.includes("'translation'")
      && diagnostic.range.start === translationRange?.start
      && diagnostic.range.end === translationRange?.end
    ));
  });

  it("validates item property-specific fields", () => {
    const result = compileSource([
      "item invalid_range_property {",
      "  merge {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:time,",
      "      source: day_time,",
      "      period: 0,",
      "      wobble: \"yes\",",
      "      entries: [{ threshold: 0, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_select_property {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:block_state,",
      "      component: 1,",
      "      cases: [{ when: stone, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_main_hand_when {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ when: \"middle\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_charge_type_when {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:charge_type,",
      "      cases: [{ when: [\"arrow\", \"bad\"], model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_display_context_when {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:display_context,",
      "      cases: [{ when: \"sideways\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_resource_id_when {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:potion_contents,",
      "      cases: [{ when: 1, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_condition_property {",
      "  merge {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:component,",
      "      predicate: 1,",
      "      on_true: { type: minecraft:model, model: minecraft:item/base },",
      "      on_false: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}",
      "item invalid_custom_model_data_index {",
      "  merge {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:custom_model_data,",
      "      index: -1,",
      "      cases: [{ when: 1, model: { type: minecraft:model, model: minecraft:item/base } }],",
      "      fallback: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}",
      "item invalid_condition_has_component {",
      "  merge {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:has_component,",
      "      component: 1,",
      "      ignore_default: \"yes\",",
      "      on_true: { type: minecraft:model, model: minecraft:item/base },",
      "      on_false: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}",
      "item unknown_property {",
      "  merge {",
      "    model: { type: minecraft:select, property: minecraft:unknown, cases: [] }",
      "  }",
      "}"
    ], {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.missingItemPropertyField"));
    assert.ok(codes.includes("rsgl.invalidItemPropertyField"));
    assert.ok(codes.includes("rsgl.unexpectedItemPropertyField"));
    assert.ok(codes.includes("rsgl.invalidItemProperty"));
    assert.ok(codes.includes("rsgl.invalidItemSelectWhenValue"));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidItemSelectWhenValue" && diagnostic.message.includes("resource ids")));
    const invalidRangeUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_range_property.json"));
    const periodRange = invalidRangeUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/period")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unexpectedItemPropertyField"
      && diagnostic.message.includes("period")
      && diagnostic.range.start === periodRange?.start
      && diagnostic.range.end === periodRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'period'")
      && diagnostic.range.start === periodRange?.start
      && diagnostic.range.end === periodRange?.end
    ));
    const sourceRange = invalidRangeUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/source")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'source'")
      && diagnostic.range.start === sourceRange?.start
      && diagnostic.range.end === sourceRange?.end
    ));
    const invalidSelectUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_select_property.json"));
    const componentRange = invalidSelectUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/component")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unexpectedItemPropertyField"
      && diagnostic.message.includes("component")
      && diagnostic.range.start === componentRange?.start
      && diagnostic.range.end === componentRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'component'")
      && diagnostic.range.start === componentRange?.start
      && diagnostic.range.end === componentRange?.end
    ));
    const invalidConditionUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_condition_property.json"));
    const conditionPropertyRange = invalidConditionUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/property")?.sourceRange;
    const predicateRange = invalidConditionUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/predicate")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.missingItemPropertyField"
      && diagnostic.message.includes("'value'")
      && diagnostic.range.start === conditionPropertyRange?.start
      && diagnostic.range.end === conditionPropertyRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'predicate'")
      && diagnostic.range.start === predicateRange?.start
      && diagnostic.range.end === predicateRange?.end
    ));
    const invalidCustomModelDataUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_custom_model_data_index.json"));
    const customIndexRange = invalidCustomModelDataUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/index")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'index'")
      && diagnostic.range.start === customIndexRange?.start
      && diagnostic.range.end === customIndexRange?.end
    ));
    const invalidHasComponentUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_condition_has_component.json"));
    const hasComponentRange = invalidHasComponentUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/component")?.sourceRange;
    const ignoreDefaultRange = invalidHasComponentUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/ignore_default")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'component'")
      && diagnostic.range.start === hasComponentRange?.start
      && diagnostic.range.end === hasComponentRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemPropertyField"
      && diagnostic.message.includes("'ignore_default'")
      && diagnostic.range.start === ignoreDefaultRange?.start
      && diagnostic.range.end === ignoreDefaultRange?.end
    ));
    const unknownPropertyUnit = result.units.find(unit => unit.outputPath.endsWith("unknown_property.json"));
    const unknownPropertyRange = unknownPropertyUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/property")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemProperty"
      && diagnostic.range.start === unknownPropertyRange?.start
      && diagnostic.range.end === unknownPropertyRange?.end
    ));
    const displayContextUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_display_context_when.json"));
    const displayContextWhenRange = displayContextUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/cases/0/when")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSelectWhenValue"
      && diagnostic.message.includes("display_context")
      && diagnostic.range.start === displayContextWhenRange?.start
      && diagnostic.range.end === displayContextWhenRange?.end
    ));
    const resourceIdWhenUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_resource_id_when.json"));
    const resourceIdWhenRange = resourceIdWhenUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/cases/0/when")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemSelectWhenValue"
      && diagnostic.message.includes("resource ids")
      && diagnostic.range.start === resourceIdWhenRange?.start
      && diagnostic.range.end === resourceIdWhenRange?.end
    ));
  });

  it("applies item schema history at exact target boundaries", () => {
    const validate = (
      content: Record<string, import("../../src/compiler").JsonValue>,
      major: number,
      minor = 0
    ) => canonicalizeAndValidateResourceUnits([minimalItemUnit(content)], {
      targetPackFormat: { major, minor },
      resourceExists: () => true
    });
    const has = (
      diagnostics: ReturnType<typeof validate>,
      code: string
    ) => diagnostics.some(diagnostic => diagnostic.code === code);
    const leaf = (): Record<string, import("../../src/compiler").JsonValue> => ({
      type: "minecraft:model",
      model: "minecraft:item/base"
    });
    const special = (
      type: string,
      fields: Record<string, import("../../src/compiler").JsonValue> = {}
    ): Record<string, import("../../src/compiler").JsonValue> => ({
      type: "minecraft:special",
      base: "minecraft:item/base",
      model: { type: "minecraft:" + type, ...fields }
    });

    assert.ok(has(validate({ model: leaf() }, 43), "rsgl.unsupportedItemModelType"));
    assert.ok(!has(validate({ model: leaf() }, 44), "rsgl.unsupportedItemModelType"));

    const componentSelect = {
      type: "minecraft:select",
      property: "minecraft:component",
      component: "minecraft:custom_name",
      cases: [],
      fallback: leaf()
    };
    assert.ok(has(validate({ model: componentSelect }, 47), "rsgl.unsupportedItemProperty"));
    assert.ok(!has(validate({ model: componentSelect }, 48), "rsgl.unsupportedItemProperty"));

    const componentCondition = {
      type: "minecraft:condition",
      property: "minecraft:component",
      predicate: "exists",
      value: true,
      on_true: leaf(),
      on_false: leaf()
    };
    assert.ok(has(validate({ model: componentCondition }, 48), "rsgl.unsupportedItemProperty"));
    assert.ok(!has(validate({ model: componentCondition }, 49), "rsgl.unsupportedItemProperty"));

    const historicalTime = {
      type: "minecraft:range_dispatch",
      property: "minecraft:time",
      natural_only: true,
      entries: [],
      fallback: leaf()
    };
    assert.ok(!has(validate({ model: historicalTime }, 45), "rsgl.unsupportedItemPropertyField"));
    assert.ok(has(validate({ model: historicalTime }, 46), "rsgl.unsupportedItemPropertyField"));
    const currentTime = {
      type: "minecraft:range_dispatch",
      property: "minecraft:time",
      source: "daytime",
      entries: [],
      fallback: leaf()
    };
    assert.ok(has(validate({ model: currentTime }, 45), "rsgl.unsupportedItemPropertyField"));
    assert.ok(!has(validate({ model: currentTime }, 46), "rsgl.unsupportedItemPropertyField"));
    assert.ok(has(validate({ model: leaf(), hand_animation_on_swap: false }, 45), "rsgl.unsupportedItemFeature"));
    assert.ok(!has(validate({ model: leaf(), hand_animation_on_swap: false }, 46), "rsgl.unsupportedItemFeature"));

    assert.ok(has(validate({ model: special("player_head") }, 62), "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(!has(validate({ model: special("player_head") }, 63), "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(has(validate({ model: leaf(), oversized_in_gui: true }, 62), "rsgl.unsupportedItemFeature"));
    assert.ok(!has(validate({ model: leaf(), oversized_in_gui: true }, 63), "rsgl.unsupportedItemFeature"));
    assert.ok(has(validate({ model: leaf(), swap_animation_scale: 1 }, 69), "rsgl.unsupportedItemFeature"));
    assert.ok(!has(validate({ model: leaf(), swap_animation_scale: 1 }, 70), "rsgl.unsupportedItemFeature"));

    const shelfContext = {
      type: "minecraft:select",
      property: "minecraft:display_context",
      cases: [{ when: "on_shelf", model: leaf() }],
      fallback: leaf()
    };
    assert.ok(has(validate({ model: shelfContext }, 65, 1), "rsgl.invalidItemSelectWhenValue"));
    assert.ok(!has(validate({ model: shelfContext }, 65, 2), "rsgl.invalidItemSelectWhenValue"));

    const transformed = {
      ...leaf(),
      transformation: { translation: [0, 0, 0] }
    };
    assert.ok(has(validate({ model: transformed }, 82), "rsgl.unsupportedItemTransformation"));
    assert.ok(!has(validate({ model: transformed }, 83), "rsgl.unsupportedItemTransformation"));
    for (const type of ["bell", "book"]) {
      const fields: Record<string, import("../../src/compiler").JsonValue> = type === "book"
        ? { open_angle: 45.5, page1: 0, page2: 1 }
        : {};
      assert.ok(has(validate({ model: special(type, fields) }, 82), "rsgl.unsupportedItemSpecialModelType"));
      assert.ok(!has(validate({ model: special(type, fields) }, 83), "rsgl.unsupportedItemSpecialModelType"));
      assert.ok(!has(validate({ model: special(type, fields) }, 83), "rsgl.invalidItemSpecialModelField"));
    }

    const shulker = special("shulker_box", {
      texture: "minecraft:entity/shulker/shulker",
      orientation: "up"
    });
    assert.ok(!has(validate({ model: shulker }, 82), "rsgl.unexpectedItemSpecialModelField"));
    assert.ok(has(validate({ model: shulker }, 83), "rsgl.unexpectedItemSpecialModelField"));

    const standingSign = special("standing_sign", {
      attachment: "ground",
      wood_type: "oak"
    });
    assert.ok(!has(validate({ model: standingSign }, 86), "rsgl.unexpectedItemSpecialModelField"));

    assert.ok(!has(validate({ model: special("bed") }, 85), "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(has(validate({ model: special("bed") }, 86), "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(!has(validate({ model: special("standing_sign") }, 86), "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(has(validate({ model: special("standing_sign") }, 87), "rsgl.unsupportedItemSpecialModelType"));
  });

  it("uses the historical schema union when no target is declared", () => {
    const diagnostics = canonicalizeAndValidateResourceUnits([
      minimalItemUnit({
        model: {
          type: "minecraft:special",
          base: "minecraft:item/base",
          model: {
            type: "minecraft:shulker_box",
            texture: "minecraft:entity/shulker/shulker",
            orientation: "north"
          }
        }
      }),
      minimalItemUnit({
        model: {
          type: "minecraft:special",
          base: "minecraft:item/base",
          model: { type: "minecraft:bed" }
        }
      })
    ], {
      resourceExists: () => true
    });

    assert.ok(!diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedItemSpecialModelType"));
    assert.ok(!diagnostics.some(diagnostic => diagnostic.code === "rsgl.unexpectedItemSpecialModelField"));
    assert.ok(!diagnostics.some(diagnostic => diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"));

    const unknown = canonicalizeAndValidateResourceUnits([minimalItemUnit({
      model: { type: "minecraft:model", model: "minecraft:item/base", mystery: true }
    })], {
      resourceExists: () => true
    });
    assert.ok(unknown.some(diagnostic => diagnostic.code === "rsgl.unexpectedItemModelField"));
  });

  it("requires one complete historical schema to accept the whole item-model tree", () => {
    const leaf = (): Record<string, import("../../src/compiler").JsonValue> => ({
      type: "minecraft:model",
      model: "minecraft:item/base"
    });
    const timeUnit = minimalItemUnit({
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:time",
        natural_only: true,
        source: "daytime",
        entries: [],
        fallback: leaf()
      }
    });
    timeUnit.sourceMap.mappings.push({
      generatedPath: "/model/source",
      sourceFile: "time.rsgl",
      sourceRange: { start: 10, end: 17 },
      reason: "direct",
      expansionStack: []
    });
    const noTargetTime = canonicalizeAndValidateResourceUnits([timeUnit], {
      resourceExists: () => true
    });
    const timeShape = noTargetTime.find(diagnostic =>
      diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"
    );
    assert.deepStrictEqual(timeShape?.range, { start: 10, end: 17 });

    const target45 = canonicalizeAndValidateResourceUnits([timeUnit], {
      targetPackFormat: { major: 45 },
      resourceExists: () => true
    });
    assert.ok(target45.some(diagnostic =>
      diagnostic.code === "rsgl.unsupportedItemPropertyField"
      && diagnostic.message.includes("source")
    ));
    assert.ok(!target45.some(diagnostic => diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"));

    const target46 = canonicalizeAndValidateResourceUnits([timeUnit], {
      targetPackFormat: { major: 46 },
      resourceExists: () => true
    });
    assert.ok(target46.some(diagnostic =>
      diagnostic.code === "rsgl.unsupportedItemPropertyField"
      && diagnostic.message.includes("natural_only")
    ));
    assert.ok(!target46.some(diagnostic => diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"));

    const specialUnit = minimalItemUnit({
      model: {
        type: "minecraft:special",
        base: "minecraft:item/base",
        model: {
          type: "minecraft:shulker_box",
          texture: "minecraft:entity/shulker/shulker",
          orientation: "up"
        },
        transformation: { translation: [0, 0, 0] }
      }
    });
    specialUnit.sourceMap.mappings.push({
      generatedPath: "/model/model/orientation",
      sourceFile: "special.rsgl",
      sourceRange: { start: 30, end: 41 },
      reason: "direct",
      expansionStack: []
    });
    const noTargetSpecial = canonicalizeAndValidateResourceUnits([specialUnit], {
      resourceExists: () => true
    });
    const specialShape = noTargetSpecial.find(diagnostic =>
      diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"
    );
    assert.deepStrictEqual(specialShape?.range, { start: 30, end: 41 });

    const rootHistoryUnit = minimalItemUnit({
      model: {
        type: "minecraft:condition",
        property: "minecraft:shift_down",
        on_true: leaf(),
        on_false: leaf()
      },
      swap_animation_scale: 1
    });
    rootHistoryUnit.sourceMap.mappings.push({
      generatedPath: "/swap_animation_scale",
      sourceFile: "root-history.rsgl",
      sourceRange: { start: 50, end: 70 },
      reason: "direct",
      expansionStack: []
    });
    const noTargetRoot = canonicalizeAndValidateResourceUnits([rootHistoryUnit], {
      resourceExists: () => true
    });
    const rootShape = noTargetRoot.find(diagnostic =>
      diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"
    );
    assert.deepStrictEqual(rootShape?.range, { start: 50, end: 70 });

    const historicalOnly = canonicalizeAndValidateResourceUnits([minimalItemUnit({
      model: {
        type: "minecraft:special",
        base: "minecraft:item/base",
        model: {
          type: "minecraft:shulker_box",
          texture: "minecraft:entity/shulker/shulker",
          orientation: "up"
        }
      }
    })], { resourceExists: () => true });
    const modernOnly = canonicalizeAndValidateResourceUnits([minimalItemUnit({
      model: { ...leaf(), transformation: { translation: [0, 0, 0] } }
    })], { resourceExists: () => true });
    assert.ok(!historicalOnly.some(diagnostic => diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"));
    assert.ok(!modernOnly.some(diagnostic => diagnostic.code === "rsgl.incompatibleHistoricalItemModelShape"));
  });

  it("enforces closed case, range-entry, and item-definition root shapes", () => {
    const leaf = (): Record<string, import("../../src/compiler").JsonValue> => ({
      type: "minecraft:model",
      model: "minecraft:item/base"
    });
    const unit = minimalItemUnit({
      future_flag: 1,
      model: {
        type: "minecraft:composite",
        models: [
          {
            type: "minecraft:select",
            property: "minecraft:main_hand",
            cases: [
              { when: "left", extra_case: true },
              { model: leaf() }
            ],
            fallback: leaf()
          },
          {
            type: "minecraft:range_dispatch",
            property: "minecraft:count",
            entries: [
              { threshold: 0, extra_entry: true },
              { model: leaf() }
            ],
            fallback: leaf()
          }
        ]
      }
    });
    const expectedRanges = new Map<string, { start: number; end: number }>([
      ["/future_flag", { start: 2, end: 5 }],
      ["/model/models/0/cases/0/model", { start: 10, end: 15 }],
      ["/model/models/0/cases/0/extra_case", { start: 20, end: 25 }],
      ["/model/models/0/cases/1/when", { start: 26, end: 29 }],
      ["/model/models/1/entries/0/model", { start: 30, end: 35 }],
      ["/model/models/1/entries/0/extra_entry", { start: 40, end: 45 }],
      ["/model/models/1/entries/1/threshold", { start: 46, end: 49 }]
    ]);
    for (const [generatedPath, sourceRange] of expectedRanges) {
      unit.sourceMap.mappings.push({
        generatedPath,
        sourceFile: "closed-shapes.rsgl",
        sourceRange,
        reason: "direct",
        expansionStack: []
      });
    }

    const diagnostics = canonicalizeAndValidateResourceUnits([unit], {
      resourceExists: () => true
    });
    const expectAt = (code: string, generatedPath: string, messagePart?: string): void => {
      const diagnostic = diagnostics.find(candidate =>
        candidate.code === code && (!messagePart || candidate.message.includes(messagePart))
      );
      assert.deepStrictEqual(diagnostic?.range, expectedRanges.get(generatedPath));
    };
    expectAt("rsgl.unexpectedItemTopLevelField", "/future_flag");
    expectAt("rsgl.missingItemModelClauseField", "/model/models/0/cases/0/model", "select case");
    expectAt("rsgl.unexpectedItemSelectCaseField", "/model/models/0/cases/0/extra_case");
    expectAt("rsgl.invalidItemSelectCase", "/model/models/0/cases/1/when");
    expectAt("rsgl.missingItemModelClauseField", "/model/models/1/entries/0/model", "range_dispatch entry");
    expectAt("rsgl.unexpectedItemRangeEntryField", "/model/models/1/entries/0/extra_entry");
    expectAt("rsgl.invalidItemRangeThreshold", "/model/models/1/entries/1/threshold");
  });

  it("validates transformation ownership and signed tint colors", () => {
    const valid = canonicalizeAndValidateResourceUnits([minimalItemUnit({
      model: {
        type: "minecraft:model",
        model: "minecraft:item/base",
        transformation: {
          left_rotation: { axis: [0, 1, 0], angle: 45 },
          translation: [0, 0, 0]
        },
        tints: [
          { type: "minecraft:constant", value: -2147483648 },
          { type: "minecraft:constant", value: 2147483647 },
          { type: "minecraft:constant", value: [0, 0.5, 1] }
        ]
      }
    })], {
      targetPackFormat: { major: 83, minor: 0 },
      resourceExists: () => true
    });
    assert.ok(!valid.some(diagnostic => diagnostic.code === "rsgl.invalidItemTransformation"));
    assert.ok(!valid.some(diagnostic => diagnostic.code === "rsgl.invalidItemTintColor"));

    const invalid = canonicalizeAndValidateResourceUnits([
      minimalItemUnit({ model: 1 }),
      minimalItemUnit({
        model: {
          type: "minecraft:empty",
          transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        }
      }),
      minimalItemUnit({
        model: {
          type: "minecraft:model",
          model: "minecraft:item/base",
          transformation: { translation: [0, 0, 0], extra: true },
          tints: [{ type: "minecraft:constant", value: 2147483648 }]
        }
      })
    ], {
      targetPackFormat: { major: 83, minor: 0 },
      resourceExists: () => true
    });
    const codes = invalid.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidItemModelDefinition"));
    assert.ok(codes.includes("rsgl.invalidItemTransformationOwner"));
    assert.ok(codes.includes("rsgl.unknownItemTransformationField"));
    assert.ok(codes.includes("rsgl.invalidItemTintColor"));
  });
});
