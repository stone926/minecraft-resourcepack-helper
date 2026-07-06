import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile, compileRsglModule, compileRsglProgram, inferBlockstateSchemaFromContent, validateResourceUnits, type JsonValue } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { createRsglWorkspaceValidationOptions } from "../../src/workspaceValidation";
import { createPngBytes, createTempDir, minimalItemUnit } from "./rsglTestHelpers";

describe("RSGL compiler validation", () => {
  it("validates generated resource references and target-gated fields", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");

      fs.writeFileSync(path.join(root, "bad_when.json"), JSON.stringify({
        multipart: [
          {
            when: [],
            apply: { model: "minecraft:block/missing_empty_when" }
          }
        ]
      }));

      const result = compileRsglModule(parseRsgl([
        "model block stone {",
        "  parent minecraft:block/missing_parent",
        "  textures { all: minecraft:block/missing_texture }",
        "}",
        "blockstate stone {",
        "  variants {",
        "    {} -> { model: minecraft:block/missing_model, z: 90, weight: 0 }",
        "  }",
        "}",
        "blockstate malformed {",
        "  raw_json {",
        "    variants: {",
        "      \"facing=north,facing=south\": { model: minecraft:block/missing_duplicate, x: 45, uvlock: \"yes\" }",
        "      \"broken\": { model: minecraft:block/missing_broken, y: 45 }",
        "    }",
        "    multipart: [",
        "      { apply: [{ model: minecraft:block/missing_part, z: 45, weight: -1 }] }",
        "    ]",
        "  }",
        "}",
        "blockstate bad_when {",
        "  raw_json {",
        "    multipart: [",
        "      { when: {}, apply: { model: minecraft:block/missing_empty_condition } },",
        "      { when: { OR: [], north: true }, apply: { model: minecraft:block/missing_mixed } },",
        "      { when: { AND: [{ north: true }, []] }, apply: { model: minecraft:block/missing_nested } },",
        "      { when: { east: \"true||false\" }, apply: { model: minecraft:block/missing_value } }",
        "    ]",
        "  }",
        "}",
        "blockstate bad_when_file {",
        "  raw_json(\"./bad_when.json\")",
        "}"
      ].join("\n")), {
        fileName: mainFile,
        targetPackFormat: { major: 74 },
        resourceExists: () => false
      });

      const codes = result.diagnostics.map(diagnostic => diagnostic.code);
      assert.ok(codes.includes("rsgl.modelNotFound"));
      assert.ok(codes.includes("rsgl.textureNotFound"));
      assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
      assert.ok(codes.includes("rsgl.invalidRandomWeight"));
      assert.ok(codes.includes("rsgl.invalidBlockstateRotation"));
      assert.ok(codes.includes("rsgl.invalidBlockstateUvlock"));
      assert.ok(codes.includes("rsgl.invalidBlockstateVariantKey"));
      assert.ok(codes.includes("rsgl.duplicateBlockstateVariantProperty"));
      assert.ok(codes.includes("rsgl.emptyBlockstateWhen"));
      assert.ok(codes.includes("rsgl.invalidBlockstateWhen"));
      assert.ok(codes.includes("rsgl.mixedBlockstateWhenCondition"));
      assert.ok(codes.includes("rsgl.invalidBlockstateLogicalCondition"));
      assert.ok(codes.includes("rsgl.invalidBlockstateWhenValue"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates blockstate state names, values, and inferred domains", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate invalid_variant_states {",
      "  raw_json {",
      "    variants: {",
      "      \"bad-state=north\": { model: minecraft:block/stone }",
      "      \"facing=North\": { model: minecraft:block/stone }",
      "      \"powered=true\": { model: minecraft:block/stone }",
      "      \"powered=on\": { model: minecraft:block/stone }",
      "    }",
      "  }",
      "}",
      "blockstate invalid_when_states {",
      "  raw_json {",
      "    multipart: [",
      "      { when: { facing: \"north|north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { facing: \"north|!north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { AND: [{ facing: \"north\" }, { facing: \"!north\" }] }, apply: { model: minecraft:block/stone } }",
      "    ]",
      "  }",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidBlockstateStateProperty"));
    assert.ok(codes.includes("rsgl.invalidBlockstateStateValue"));
    assert.ok(codes.includes("rsgl.mixedBlockstateStateValueDomain"));
    assert.ok(codes.includes("rsgl.duplicateBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.tautologicalBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.contradictoryBlockstateWhenCondition"));
  });

  it("validates blockstate states against supplied schemas", () => {
    const schemaRequests: string[] = [];
    const schemas: Record<string, { properties: Record<string, readonly string[]> }> = {
      lamp: {
        properties: {
          facing: ["north", "south"],
          lit: ["true", "false"]
        }
      },
      fence: {
        properties: {
          north: ["true", "false"]
        }
      }
    };
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    [facing=north lit=true] -> { model: minecraft:block/lamp }",
      "    [facing=up lit=maybe bogus=true] -> { model: minecraft:block/lamp }",
      "  }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    when { north: true, side: east } apply { model: minecraft:block/fence_side }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      blockstateSchema: id => {
        schemaRequests.push(`${id.namespace}:${id.path}`);
        return schemas[id.path] ?? null;
      }
    });

    assert.deepStrictEqual(schemaRequests.sort(), ["minecraft:fence", "minecraft:lamp"]);
    assert.strictEqual(result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue").length, 2);
    assert.strictEqual(result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.unknownBlockstateStateProperty").length, 2);

    const lamp = result.units.find(unit => unit.outputPath.endsWith("blockstates/lamp.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("blockstates/fence.json"));
    const invalidVariantRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/bogus=true,facing=up,lit=maybe")?.sourceRange;
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0")?.sourceRange;

    assert.ok(invalidVariantRange);
    assert.ok(multipartRange);
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("'facing' does not allow value 'up'"))?.range,
      invalidVariantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("'side' is not defined"))?.range,
      multipartRange
    );
  });

  it("infers blockstate schemas from existing JSON content", () => {
    assert.deepStrictEqual(inferBlockstateSchemaFromContent({
      variants: {
        ["facing=north,lit=true"]: { model: "minecraft:block/lamp" },
        ["facing=south,lit=false"]: { model: "minecraft:block/lamp" }
      },
      multipart: [
        { when: { north: true }, apply: { model: "minecraft:block/fence" } },
        { when: { ["OR"]: [{ side: "east|west" }, { side: "!north" }] }, apply: { model: "minecraft:block/fence" } }
      ]
    }), {
      properties: {
        facing: ["north", "south"],
        lit: ["false", "true"],
        north: ["true"],
        side: ["east", "north", "west"]
      }
    });
    assert.strictEqual(inferBlockstateSchemaFromContent({ variants: { [""]: { model: "minecraft:block/stone" } } }), null);
  });

  it("maps blockstate validation diagnostics to generated entry source ranges", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    [facing=north] -> { model: minecraft:block/missing_variant, x: 45 }",
      "  }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    when { north: \"true||false\" } apply { model: minecraft:block/missing_multipart, z: 45 }",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 74 },
      resourceExists: () => false
    });

    const lamp = result.units.find(unit => unit.outputPath.endsWith("blockstates/lamp.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("blockstates/fence.json"));
    const variantRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north")?.sourceRange;
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0")?.sourceRange;

    assert.ok(variantRange);
    assert.ok(multipartRange);
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateRotation")?.range,
      variantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_variant"))?.range,
      variantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateWhenValue")?.range,
      multipartRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation")?.range,
      multipartRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_multipart"))?.range,
      multipartRange
    );
  });

  it("validates model display, element geometry, rotation, and face fields", () => {
    const valid = compileRsglModule(parseRsgl([
      "model block valid_geometry {",
      "  display {",
      "    gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [1, 1, 1] }",
      "    on_shelf: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] }",
      "  }",
      "  textures { all: minecraft:block/stone }",
      "  elements [",
      "    {",
      "      from: [0, 0, 0]",
      "      to: [16, 16, 16]",
      "      rotation: { origin: [8, 8, 8], axis: y, angle: 45, rescale: true }",
      "      shade: true",
      "      light_emission: 0",
      "      faces: { north: { uv: [0, 0, 16, 16], texture: \"#all\", cullface: north, rotation: 90, tintindex: -1 } }",
      "    }",
      "  ]",
      "}",
    ].join("\n")));
    const validCodes = valid.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementVector"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelElementCoordinateOutOfRange"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceTexture"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceRotation"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelDisplayContext"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementRotationAxis"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelFaceUvOutOfRange"), false);

    const invalid = compileRsglModule(parseRsgl([
      "model block broken_geometry {",
      "  display {",
      "    bad_context: { rotation: [0, 0, 0] }",
      "    gui: { rotation: [0, 0], translation: [0, 81, 0], scale: [1, 5, 1] }",
      "    ground: \"bad\"",
      "  }",
      "  textures { all: minecraft:block/stone }",
      "  elements [",
      "    {",
      "      from: [-17, 0, 0]",
      "      to: [16, 33, 16]",
      "      rotation: { origin: [8, 8], axis: q, angle: \"bad\", rescale: \"yes\" }",
      "      shade: \"yes\"",
      "      light_emission: 16",
      "      faces: {",
      "        north: { texture: minecraft:block/stone, rotation: 45, uv: [0, 0, 17, 16], cullface: \"bad\", tintindex: -2 },",
      "        south: { texture: \"#all\", uv: [0, 0, \"bad\"] },",
      "        top: { texture: \"#all\" }",
      "      }",
      "    }",
      "    {",
      "      from: [0, 0]",
      "      to: [0, 0, \"bad\"]",
      "      faces: { south: { texture: \"#all\", rotation: 270 } }",
      "    }",
      "  ]",
      "}",
    ].join("\n")));
    const invalidCodes = invalid.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(invalidCodes.includes("rsgl.invalidModelElementVector"));
    assert.ok(invalidCodes.includes("rsgl.modelElementCoordinateOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceTexture"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceRotation"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayContext"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayTransform"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayVector"));
    assert.ok(invalidCodes.includes("rsgl.modelDisplayTranslationOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.modelDisplayScaleOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationOrigin"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationAxis"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationAngle"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRescale"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementShade"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementLightEmission"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceName"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceUv"));
    assert.ok(invalidCodes.includes("rsgl.modelFaceUvOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceCullface"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceTintIndex"));
  });

  it("uses RSGL target declarations for version-gated validation", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format [74, 0]",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block rotated { parent minecraft:block/cube_all }",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
  });

  it("resolves RSGL Minecraft version targets to pack formats", () => {
    const modern = compileRsglModule(parseRsgl([
      "target java mc \"1.21.11\"",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}"
    ].join("\n")));
    const older = compileRsglModule(parseRsgl([
      "target java mc \"1.21.10\"",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}"
    ].join("\n")));

    assert.strictEqual(modern.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"), false);
    assert.ok(older.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"));
  });

  it("reports invalid and conflicting RSGL target formats", () => {
    const invalid = compileRsglModule(parseRsgl("target java format \"newest\""));
    assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidTargetFormat"));

    const invalidMinecraftVersion = compileRsglModule(parseRsgl("target java mc 1"));
    assert.ok(invalidMinecraftVersion.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidTargetMinecraftVersion"));

    const unknownMinecraftVersion = compileRsglModule(parseRsgl("target java mc \"1.99.0\""));
    assert.ok(unknownMinecraftVersion.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unknownTargetMinecraftVersion"));

    const firstFile = path.resolve("pack", "first.rsgl");
    const secondFile = path.resolve("pack", "second.rsgl");
    const conflicting = compileRsglProgram([
      {
        fileName: firstFile,
        module: parseRsgl("target java format [88, 0]")
      },
      {
        fileName: secondFile,
        module: parseRsgl("target java format [89, 0]")
      }
    ]);

    assert.ok(conflicting.diagnostics.some(diagnostic => diagnostic.code === "rsgl.conflictingTargetFormat"));
  });

  it("validates item model condition trees", () => {
    const result = compileRsglModule(parseRsgl([
      "item broken_compass {",
      "  raw_json {",
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
      "  raw_json {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:count,",
      "      entries: []",
      "    }",
      "  }",
      "}",
      "item broken_select {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ model: { type: minecraft:model, model: minecraft:item/missing_case } }]",
      "    }",
      "  }",
      "}",
      "item broken_condition {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_true: { type: minecraft:model, model: minecraft:item/missing_true }",
      "    }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.unsortedItemRangeThresholds"));
    assert.ok(codes.includes("rsgl.emptyItemRangeEntries"));
    assert.ok(codes.includes("rsgl.itemModelMissingFallback"));
    assert.ok(codes.includes("rsgl.invalidItemSelectCase"));
    assert.ok(codes.includes("rsgl.invalidItemConditionBranch"));
    const brokenCompassUnit = result.units.find(unit => unit.outputPath.endsWith("broken_compass.json"));
    const brokenCompassModelRange = brokenCompassUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model")?.sourceRange;
    const unsortedThresholdRange = brokenCompassUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/entries/1/threshold")?.sourceRange;
    const unsortedDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsortedItemRangeThresholds");
    assert.deepStrictEqual(unsortedDiagnostic?.range, unsortedThresholdRange);
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
    const result = compileRsglModule(parseRsgl([
      "item composite_with_missing_child {",
      "  raw_json {",
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
      "  raw_json {",
      "    model: { type: minecraft:composite, models: \"bad\" }",
      "  }",
      "}",
      "item invalid_composite_child {",
      "  raw_json {",
      "    model: { type: minecraft:composite, models: [1] }",
      "  }",
      "}",
      "item unknown_model_type {",
      "  raw_json {",
      "    model: { type: minecraft:unknown }",
      "  }",
      "}",
      "item invalid_model_reference {",
      "  raw_json {",
      "    model: { type: minecraft:model, model: 1 }",
      "  }",
      "}"
    ].join("\n")), {
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

    const emptyCompositeDiagnostics = validateResourceUnits([minimalItemUnit({
      model: { type: "minecraft:composite", models: [] }
    })]);
    assert.ok(emptyCompositeDiagnostics.some(diagnostic => diagnostic.code === "rsgl.emptyItemCompositeModels"));
  });

  it("validates item special model resources and shape", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "item broken_special {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/missing_base,",
      "      model: { type: minecraft:chest, texture: \"missing\" }",
      "    }",
      "  }",
      "}",
      "item invalid_special {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: 1, model: \"not_an_object\" }",
      "  }",
      "}"
    ].join("\n")), {
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
    const result = compileRsglModule(parseRsgl([
      "item invalid_special_fields {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/base,",
      "      model: { type: minecraft:chest, chest_type: middle, openness: 2 }",
      "    }",
      "  }",
      "}",
      "item unknown_special_type {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:unknown } }",
      "  }",
      "}",
      "item invalid_special_texture {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:chest, texture: 1 } }",
      "  }",
      "}",
      "item invalid_tints {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [",
      "        { type: minecraft:constant, value: [1, 0.5] },",
      "        { type: minecraft:constant, value: -1 },",
      "        { type: minecraft:constant, value: 16777216 },",
      "        { type: minecraft:grass, temperature: 2 },",
      "        { type: minecraft:grass, temperature: 0.5, downfall: 2 },",
      "        { type: minecraft:custom_model_data, default: 1, index: -1 },",
      "        { type: minecraft:unknown }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item invalid_nested_tints {",
      "  raw_json {",
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
    ].join("\n")), {
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
    const result = compileRsglModule(parseRsgl([
      "item invalid_top_level {",
      "  raw_json {",
      "    hand_animation_on_swap: \"yes\",",
      "    oversized_in_gui: 1,",
      "    swap_animation_scale: \"large\",",
      "    model: { type: minecraft:model, model: minecraft:item/base }",
      "  }",
      "}",
      "item invalid_matrix {",
      "  raw_json {",
      "    model: { type: minecraft:model, model: minecraft:item/base, transformation: [1, 0, 0] }",
      "  }",
      "}",
      "item invalid_transform_object {",
      "  raw_json {",
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
    ].join("\n")), {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidItemTopLevelField"));
    assert.ok(codes.includes("rsgl.invalidItemTransformation"));
    assert.ok(codes.includes("rsgl.missingItemTransformationField"));
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
    const transformationRange = invalidTransformUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation")?.sourceRange;
    const leftRotationRange = invalidTransformUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation/left_rotation")?.sourceRange;
    const translationRange = invalidTransformUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/transformation/translation")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.missingItemTransformationField"
      && diagnostic.message.includes("'right_rotation'")
      && diagnostic.range.start === transformationRange?.start
      && diagnostic.range.end === transformationRange?.end
    ));
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
    const result = compileRsglModule(parseRsgl([
      "item invalid_range_property {",
      "  raw_json {",
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
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:block_state,",
      "      component: 1,",
      "      cases: [{ when: stone, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_main_hand_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ when: \"middle\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_charge_type_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:charge_type,",
      "      cases: [{ when: [\"arrow\", \"bad\"], model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_display_context_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:display_context,",
      "      cases: [{ when: \"sideways\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_resource_id_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:potion_contents,",
      "      cases: [{ when: 1, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_condition_property {",
      "  raw_json {",
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
      "  raw_json {",
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
      "  raw_json {",
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
      "  raw_json {",
      "    model: { type: minecraft:select, property: minecraft:unknown, cases: [] }",
      "  }",
      "}"
    ].join("\n")), {
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

  it("validates generated model parent chains and texture variables", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "model block parent_model {",
      "  textures { base: minecraft:block/inherited_texture }",
      "}",
      "model block child_model {",
      "  parent minecraft:block/parent_model",
      "  textures { all: \"#base\" }",
      "}",
      "model block missing_variable {",
      "  textures { all: \"#missing\" }",
      "}",
      "model block texture_cycle {",
      "  textures { a: \"#b\", b: \"#a\" }",
      "}",
      "model block missing_texture {",
      "  textures { base: minecraft:block/missing_texture, all: \"#base\" }",
      "}",
      "model block parent_a { parent minecraft:block/parent_b }",
      "model block parent_b { parent minecraft:block/parent_a }"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return id !== "minecraft:block/missing_texture";
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(checkedResources.includes("texture:minecraft:block/inherited_texture"));
    assert.ok(codes.includes("rsgl.unresolvedTextureVariable"));
    assert.ok(codes.includes("rsgl.textureVariableCycle"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.modelParentCycle"));
    const missingVariableUnit = result.units.find(unit => unit.outputPath.endsWith("missing_variable.json"));
    const missingVariableRange = missingVariableUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/all")?.sourceRange;
    const missingVariableDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unresolvedTextureVariable");
    assert.deepStrictEqual(missingVariableDiagnostic?.range, missingVariableRange);
    const textureCycleUnit = result.units.find(unit => unit.outputPath.endsWith("texture_cycle.json"));
    const textureCycleRange = textureCycleUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/a")?.sourceRange;
    const textureCycleDiagnostic = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.textureVariableCycle");
    assert.deepStrictEqual(textureCycleDiagnostic?.range, textureCycleRange);
    const missingTextureUnit = result.units.find(unit => unit.outputPath.endsWith("missing_texture.json"));
    const directTextureRange = missingTextureUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/base")?.sourceRange;
    const resolvedTextureRange = missingTextureUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/all")?.sourceRange;
    const missingTextureDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound" && diagnostic.message.includes("missing_texture")
    );
    assert.ok(missingTextureDiagnostics.some(diagnostic =>
      diagnostic.range.start === directTextureRange?.start && diagnostic.range.end === directTextureRange?.end
    ));
    assert.ok(missingTextureDiagnostics.some(diagnostic =>
      diagnostic.range.start === resolvedTextureRange?.start && diagnostic.range.end === resolvedTextureRange?.end
    ));
  });

  it("stops model parent validation at virtual vanilla builtin models", () => {
    const checkedResources: string[] = [];
    const loadedModels: string[] = [];
    const externalModels = new Map<string, JsonValue>([
      ["minecraft:item/generated", {
        parent: "minecraft:builtin/generated"
      }]
    ]);
    const result = compileRsglModule(parseRsgl([
      "model item generated_parent {",
      "  parent minecraft:item/generated",
      "}",
      "model block missing_child {",
      "  parent minecraft:block/missing_parent",
      "}"
    ].join("\n")), {
      resourceContent: (kind, id) => {
        assert.strictEqual(kind, "model");
        loadedModels.push(id);
        return externalModels.get(id);
      },
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const modelNotFoundDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.modelNotFound");
    assert.ok(loadedModels.includes("minecraft:item/generated"));
    assert.ok(!loadedModels.includes("minecraft:builtin/generated"));
    assert.ok(!checkedResources.includes("model:minecraft:builtin/generated"));
    assert.strictEqual(modelNotFoundDiagnostics.length, 1);
    assert.ok(modelNotFoundDiagnostics[0].message.includes("minecraft:block/missing_parent"));
  });

  it("validates external model parent chains and texture variables", () => {
    const checkedResources: string[] = [];
    const loadedModels: string[] = [];
    const externalModels = new Map<string, JsonValue>([
      ["minecraft:block/external_child", {
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }],
      ["minecraft:block/external_root", {
        textures: { root: "minecraft:block/external_texture" }
      }],
      ["minecraft:block/external_cycle_a", {
        parent: "minecraft:block/external_cycle_b"
      }],
      ["minecraft:block/external_cycle_b", {
        parent: "minecraft:block/external_cycle_a"
      }],
      ["minecraft:block/external_missing_child", {
        parent: "minecraft:block/external_missing_parent"
      }]
    ]);
    const result = compileRsglModule(parseRsgl([
      "model block child_external {",
      "  parent minecraft:block/external_child",
      "  textures { all: \"#alias\" }",
      "}",
      "model block cycle_external { parent minecraft:block/external_cycle_a }",
      "model block missing_external { parent minecraft:block/external_missing_child }"
    ].join("\n")), {
      resourceContent: (kind, id) => {
        assert.strictEqual(kind, "model");
        loadedModels.push(id);
        return externalModels.get(id);
      },
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return !(kind === "model" && id === "minecraft:block/external_missing_parent");
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(loadedModels.includes("minecraft:block/external_child"));
    assert.ok(loadedModels.includes("minecraft:block/external_root"));
    assert.ok(loadedModels.includes("minecraft:block/external_cycle_a"));
    assert.ok(loadedModels.includes("minecraft:block/external_cycle_b"));
    assert.ok(checkedResources.includes("texture:minecraft:block/external_texture"));
    assert.ok(checkedResources.includes("model:minecraft:block/external_missing_parent"));
    assert.ok(codes.includes("rsgl.modelParentCycle"));
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.strictEqual(codes.includes("rsgl.unresolvedTextureVariable"), false);
  });

  it("uses filesystem workspace validation for RSGL resources", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const mainFile = path.join(packRoot, "main.rsgl");
    const externalChild = path.join(packRoot, "assets", "minecraft", "models", "block", "external_child.json");
    const externalRoot = path.join(packRoot, "assets", "minecraft", "models", "block", "external_root.json");
    const texture = path.join(packRoot, "assets", "minecraft", "textures", "block", "external_texture.png");
    const vertexShader = path.join(packRoot, "assets", "minecraft", "shaders", "core", "screenquad.vsh");
    const fragmentShader = path.join(packRoot, "assets", "minecraft", "shaders", "post", "box_blur.fsh");
    const effectTexture = path.join(packRoot, "assets", "minecraft", "textures", "effect", "blur", "mask.png");

    try {
      fs.mkdirSync(path.dirname(externalChild), { recursive: true });
      fs.mkdirSync(path.dirname(texture), { recursive: true });
      fs.mkdirSync(path.dirname(vertexShader), { recursive: true });
      fs.mkdirSync(path.dirname(fragmentShader), { recursive: true });
      fs.mkdirSync(path.dirname(effectTexture), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(mainFile, [
        "model block workspace_child {",
        "  parent minecraft:block/external_child",
        "  textures { all: \"#alias\" }",
        "}",
        "post_effect workspace_shader {",
        "  targets { swap: {} }",
        "  passes [",
        "    { vertex_shader: minecraft:core/screenquad, fragment_shader: minecraft:post/box_blur, inputs: [{ sampler_name: \"Mask\", location: minecraft:blur/mask }], output: \"swap\" }",
        "  ]",
        "}"
      ].join("\n"));
      fs.writeFileSync(externalChild, JSON.stringify({
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }));
      fs.writeFileSync(externalRoot, JSON.stringify({
        textures: { root: "minecraft:block/external_texture" }
      }));
      fs.writeFileSync(texture, Buffer.alloc(0));
      fs.writeFileSync(vertexShader, "");
      fs.writeFileSync(fragmentShader, "");
      fs.writeFileSync(effectTexture, Buffer.alloc(0));

      const result = compileRsglFile(mainFile, createRsglWorkspaceValidationOptions({
        sourceFileName: mainFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.strictEqual(codes.includes("rsgl.modelNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.textureNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.vertexShaderNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.fragmentShaderNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.unresolvedTextureVariable"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates sound, atlas, mcmeta, and overlay resources", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "sounds custom {",
      "  \"entity.example.ambient\" {",
      "    sounds: [",
      "      \"entity/example/ambient1\",",
      "      { name: \"entity/example/ambient2\" },",
      "      { name: \"entity/example/event\", type: event }",
      "    ]",
      "  }",
      "}",
      "atlas minecraft:blocks {",
      "  sources [",
      "    { type: minecraft:directory, source: block/missing_directory },",
      "    { type: single, resource: minecraft:block/missing_single },",
      "    { type: minecraft:unstitch, resource: minecraft:block/missing_unstitch, regions: [{ sprite: block/slice, x: 0, y: 0, width: 16, height: 16 }] },",
      "    { type: filter, pattern: { namespace: \"[\", path: \"*\" } },",
      "    { type: paletted_permutations, textures: [minecraft:block/missing_palette], palette_key: minecraft:block/missing_palette_key, permutations: { red: minecraft:block/missing_permutation } }",
      "  ]",
      "}",
      "mcmeta \"assets/minecraft/textures/block/missing_anim.png\" {",
      "  animation { frametime 2 }",
      "}",
      "particles missing_particles {",
      "  textures [minecraft:particle/missing_particle]",
      "}",
      "equipment missing_equipment {",
      "  layers {",
      "    humanoid [",
      "      { texture: minecraft:missing_equipment }",
      "    ]",
      "  }",
      "}",
      "pack {",
      "  pack { description: \"Generated\" }",
      "  overlays {",
      "    entries: [",
      "      { directory: \"Bad/Overlay\", min_format: [90, 0], max_format: [89, 0] },",
      "      { directory: \"future\", min_format: [90, 0], max_format: [91, 0] }",
      "    ]",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 88 },
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.soundNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.textureDirectoryNotFound"));
    assert.ok(codes.includes("rsgl.invalidAtlasFilterPattern"));
    assert.ok(codes.includes("rsgl.invalidOverlayDirectory"));
    assert.ok(codes.includes("rsgl.invalidOverlayFormatRange"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient1"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient2"));
    assert.strictEqual(checkedResources.includes("sound:custom:entity/example/event"), false);
    assert.ok(checkedResources.includes("textureDirectory:minecraft:block/missing_directory"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_single"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_unstitch"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_palette"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_palette_key"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_permutation"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_anim"));
    assert.ok(checkedResources.includes("texture:minecraft:particle/missing_particle"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/missing_equipment"));
    const atlasUnit = result.units.find(unit => unit.outputPath.endsWith("atlases/blocks.json"));
    const atlasRange = (generatedPath: string) => {
      let current = generatedPath;
      while (current) {
        const range = atlasUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === current)?.sourceRange;
        if (range) {
          return range;
        }
        const slash = current.lastIndexOf("/");
        current = slash > 0 ? current.slice(0, slash) : "";
      }
      return atlasUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "")?.sourceRange;
    };
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureDirectoryNotFound"
      && diagnostic.message.includes("missing_directory")
      && diagnostic.range.start === atlasRange("/sources/0/source")?.start
      && diagnostic.range.end === atlasRange("/sources/0/source")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_single")
      && diagnostic.range.start === atlasRange("/sources/1/resource")?.start
      && diagnostic.range.end === atlasRange("/sources/1/resource")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_unstitch")
      && diagnostic.range.start === atlasRange("/sources/2/resource")?.start
      && diagnostic.range.end === atlasRange("/sources/2/resource")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidAtlasFilterPattern"
      && diagnostic.message.includes("namespace")
      && diagnostic.range.start === atlasRange("/sources/3/pattern/namespace")?.start
      && diagnostic.range.end === atlasRange("/sources/3/pattern/namespace")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidAtlasFilterPattern"
      && diagnostic.message.includes("path")
      && diagnostic.range.start === atlasRange("/sources/3/pattern/path")?.start
      && diagnostic.range.end === atlasRange("/sources/3/pattern/path")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_palette")
      && diagnostic.range.start === atlasRange("/sources/4/textures/0")?.start
      && diagnostic.range.end === atlasRange("/sources/4/textures/0")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_palette_key")
      && diagnostic.range.start === atlasRange("/sources/4/palette_key")?.start
      && diagnostic.range.end === atlasRange("/sources/4/palette_key")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_permutation")
      && diagnostic.range.start === atlasRange("/sources/4/permutations/red")?.start
      && diagnostic.range.end === atlasRange("/sources/4/permutations/red")?.end
    ));
  });

  it("validates mcmeta animation frames against texture metadata", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/block/animated.png\" {",
      "  animation {",
      "    width 16",
      "    height 16",
      "    frametime 0",
      "    interpolate \"yes\"",
      "    frames [0, 4, { index: 2, time: 0 }, { index: -1 }]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      textureMetadata: id => id === "minecraft:block/animated" ? { width: 16, height: 48 } : null
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidMcmetaFrameTime"));
    assert.ok(codes.includes("rsgl.invalidMcmetaInterpolate"));
    assert.ok(codes.includes("rsgl.invalidMcmetaFrameIndex"));
    assert.ok(codes.includes("rsgl.mcmetaFrameIndexOutOfRange"));
    assert.strictEqual(codes.includes("rsgl.invalidMcmetaFrameStrip"), false);
  });

  it("validates mcmeta animation frame strip dimensions", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/block/bad_strip.png\" {",
      "  animation {",
      "    frames [0]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      textureMetadata: id => id === "minecraft:block/bad_strip" ? { width: 16, height: 20 } : null
    });

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidMcmetaFrameStrip"));
  });

  it("reads mcmeta texture metadata through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const textureFile = path.join(packRoot, "assets", "minecraft", "textures", "block", "adapter_bad_strip.png");
    try {
      fs.mkdirSync(path.dirname(textureFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(textureFile, createPngBytes(16, 20));
      fs.writeFileSync(sourceFile, [
        "mcmeta \"assets/minecraft/textures/block/adapter_bad_strip.png\" {",
        "  animation { frames [0] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidMcmetaFrameStrip"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads sound metadata through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const soundFile = path.join(packRoot, "assets", "minecraft", "sounds", "entity", "example", "bad.ogg");
    try {
      fs.mkdirSync(path.dirname(soundFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(soundFile, Buffer.from("not ogg"));
      fs.writeFileSync(sourceFile, [
        "sounds minecraft {",
        "  \"entity.example.bad\" { sounds: [\"entity/example/bad\"] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidSoundMetadata"));
      assert.strictEqual(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.soundNotFound"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("infers blockstate schemas through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const blockstateFile = path.join(packRoot, "assets", "minecraft", "blockstates", "lamp.json");
    try {
      fs.mkdirSync(path.dirname(blockstateFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(blockstateFile, JSON.stringify({
        variants: {
          ["facing=north,lit=true"]: { model: "minecraft:block/lamp" },
          ["facing=south,lit=false"]: { model: "minecraft:block/lamp" }
        }
      }));
      fs.writeFileSync(sourceFile, [
        "blockstate lamp {",
        "  variants {",
        "    [facing=up lit=true extra=true] -> { model: minecraft:block/lamp }",
        "  }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue"));
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unknownBlockstateStateProperty"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
