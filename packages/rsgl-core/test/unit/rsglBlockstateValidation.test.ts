import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { inferBlockstateSchemaFromContent } from "../../src/compiler";
import { compileSource } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL blockstate validation", () => {
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

      const result = compileSource([
        "extern custom model minecraft:**",
        "extern custom texture minecraft:**",
        "model block stone {",
        "  parent minecraft:block/missing_parent",
        "  textures { all: minecraft:block/missing_texture }",
        "}",
        "blockstate variants stone {",
        "  case { kind: rotated } => minecraft:block/missing_model with { z: 90 }",
        "  case { kind: weighted } => random {",
        "    option minecraft:block/missing_weight weight 0",
        "  }",
        "}",
        "blockstate variants malformed_variants {",
        "  merge {",
        "    variants: {",
        "      \"facing=north,facing=south\": { model: minecraft:block/missing_duplicate, x: 45, uvlock: \"yes\" }",
        "      \"broken\": { model: minecraft:block/missing_broken, y: 45 }",
        "    }",
        "  }",
        "}",
        "blockstate variants single_weight {",
        "  merge { variants: { \"\": { model: minecraft:block/single_weight, weight: 2 } } }",
        "}",
        "blockstate multipart part_weight {",
        "  merge { multipart: [{ apply: { model: minecraft:block/part_weight, weight: 2 } }] }",
        "}",
        "blockstate multipart malformed_multipart {",
        "  merge {",
        "    multipart: [",
        "      { apply: [{ model: minecraft:block/missing_part, z: 45, weight: -1 }] }",
        "    ]",
        "  }",
        "}",
        "blockstate multipart bad_when {",
        "  merge {",
        "    multipart: [",
        "      { when: {}, apply: { model: minecraft:block/missing_empty_condition } },",
        "      { when: { OR: [], north: true }, apply: { model: minecraft:block/missing_mixed } },",
        "      { when: { AND: [{ north: true }, []] }, apply: { model: minecraft:block/missing_nested } },",
        "      { when: { east: \"true||false\" }, apply: { model: minecraft:block/missing_value } }",
        "    ]",
        "  }",
        "}",
        "blockstate multipart bad_when_file {",
        "  base \"./bad_when.json\"",
        "}"
      ], {
        fileName: mainFile,
        targetPackFormat: { major: 74 },
        resourceExists: () => false
      });

      const codes = result.diagnostics.map(diagnostic => diagnostic.code);
      assert.ok(codes.includes("rsgl.modelNotFound"));
      assert.ok(codes.includes("rsgl.textureNotFound"));
      assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
      assert.ok(codes.includes("rsgl.invalidRandomWeight"));
      assert.strictEqual(
        codes.filter(code => code === "rsgl.blockstateWeightInvalidContext").length,
        2
      );
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
    const result = compileSource([
      "blockstate variants invalid_variant_states {",
      "  merge {",
      "    variants: {",
      "      \"bad-state=north\": { model: minecraft:block/stone }",
      "      \"facing=North\": { model: minecraft:block/stone }",
      "      \"powered=true\": { model: minecraft:block/stone }",
      "      \"powered=on\": { model: minecraft:block/stone }",
      "    }",
      "  }",
      "}",
      "blockstate multipart invalid_when_states {",
      "  merge {",
      "    multipart: [",
      "      { when: { facing: \"north|north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { facing: \"north|!north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { AND: [{ facing: \"north\" }, { facing: \"!north\" }] }, apply: { model: minecraft:block/stone } }",
      "    ]",
      "  }",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidBlockstateStateProperty"));
    assert.ok(codes.includes("rsgl.invalidBlockstateStateValue"));
    assert.ok(codes.includes("rsgl.mixedBlockstateStateValueDomain"));
    assert.ok(codes.includes("rsgl.duplicateBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.tautologicalBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.contradictoryBlockstateWhenCondition"));
  });

  it("rejects invalid merged variant and multipart value shapes", () => {
    const result = compileSource([
      "blockstate variants invalid_values {",
      "  merge upsert { variants: {",
      "    \"null=value\": null,",
      "    \"empty=list\": [],",
      "    \"nested=list\": [[{ model: minecraft:block/nested }]],",
      "    \"missing=model\": {}",
      "  } }",
      "}",
      "blockstate multipart invalid_entries {",
      "  merge upsert { multipart: [",
      "    null,",
      "    {},",
      "    { apply: {} }",
      "  ] }",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidBlockstateMultipartEntry"));
    assert.ok(codes.includes("rsgl.emptyBlockstateModelList"));
    assert.ok(codes.includes("rsgl.nestedBlockstateModelList"));
    assert.ok(codes.filter(code => code === "rsgl.missingBlockstateModel").length >= 3);
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
    const result = compileSource([
      "blockstate variants lamp {",
      "  case { facing: north, lit: true } => minecraft:block/lamp",
      "  case { facing: up, lit: maybe, bogus: true } => minecraft:block/lamp",
      "}",
      "blockstate multipart fence {",
      "  part when $state.north == true && $state.side == east => minecraft:block/fence_side",
      "}"
    ], {
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
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0/when")?.sourceRange;

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

  it("validates boolean predicate shorthand against the blockstate schema", () => {
    const result = compileSource([
      "blockstate multipart shorthand_schema {",
      "  part when $state.north => minecraft:block/north",
      "  part when !$state.north => minecraft:block/not_north",
      "  part when $state.facing => minecraft:block/invalid_facing",
      "}"
    ], {
      resourceExists: () => true,
      blockstateSchema: () => ({
        properties: {
          north: ["true", "false"],
          facing: ["north", "south"]
        }
      })
    });

    const invalidValues = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue"
    );
    assert.strictEqual(invalidValues.length, 1);
    assert.ok(invalidValues[0].message.includes("'facing' does not allow value 'true'"));
  });

  it("rejects wildcard and partial selector overlap while keeping disjoint cases", () => {
    const result = compileSource([
      "blockstate variants wildcard_overlap {",
      "  case * => minecraft:block/default",
      "  case { facing: north } => minecraft:block/north",
      "}",
      "blockstate variants partial_overlap {",
      "  case { facing: north } => minecraft:block/north",
      "  case { facing: north, powered: true } => minecraft:block/powered",
      "}",
      "blockstate variants disjoint {",
      "  case { facing: north } => minecraft:block/north",
      "  case { facing: south } => minecraft:block/south",
      "}"
    ], { resourceExists: () => true });
    const overlaps = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.overlappingBlockstateVariantEntry"
    );

    assert.strictEqual(overlaps.length, 2);
    const disjoint = result.units.find(unit => unit.outputPath.endsWith("blockstates/disjoint.json"));
    assert.deepStrictEqual(disjoint?.content, {
      variants: {
        "facing=north": { model: "minecraft:block/north" },
        "facing=south": { model: "minecraft:block/south" }
      }
    });
  });

  it("warns for schema-backed incomplete variants and accepts complete products", () => {
    const schema = {
      properties: {
        facing: ["north", "south"],
        lit: ["true", "false"]
      }
    };
    const result = compileSource([
      "blockstate variants incomplete {",
      "  case { facing: north, lit: true } => minecraft:block/lamp",
      "}",
      "blockstate variants complete {",
      "  for facing in [\"north\", \"south\"], lit in [true, false] {",
      "    case { facing, lit } => minecraft:block/lamp",
      "  }",
      "}"
    ], {
      resourceExists: () => true,
      blockstateSchema: () => schema
    });
    const warnings = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.incompleteBlockstateVariants"
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].severity, "warning");
    assert.ok(warnings[0].message.includes("3 of 4"));
    assert.strictEqual(warnings[0].fileName, "<anonymous>");
    const complete = result.units.find(unit => unit.outputPath.endsWith("blockstates/complete.json"));
    assert.strictEqual(Object.keys((complete?.content as { variants: object }).variants).length, 4);
  });

  it("hints on duplicate single-model predicates without merging multipart parts", () => {
    const result = compileSource([
      "blockstate multipart duplicate_predicate {",
      "  part when $state.north == true => minecraft:block/first",
      "  part when $state.north == true => minecraft:block/second",
      "  part when $state.north == true => random {",
      "    option minecraft:block/random_a",
      "    option minecraft:block/random_b",
      "  }",
      "}"
    ], { resourceExists: () => true });
    const hints = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.duplicateMultipartPredicateHint"
    );

    assert.strictEqual(hints.length, 1);
    assert.strictEqual(hints[0].severity, "info");
    const unit = result.units.find(unit => unit.outputPath.endsWith("blockstates/duplicate_predicate.json"));
    const multipart = (unit?.content as { multipart: unknown[] }).multipart;
    assert.strictEqual(multipart.length, 3, "Duplicate predicates must remain separate stacking parts.");
    assert.ok(Array.isArray((multipart[2] as { apply: unknown }).apply));
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
    const result = compileSource([
      "blockstate variants lamp {",
      "  merge upsert { variants: {",
      "    \"facing=north\": { model: minecraft:block/missing_variant, x: 45 }",
      "  } }",
      "}",
      "blockstate multipart fence {",
      "  merge append { multipart: [{",
      "    when: { north: \"true||false\" },",
      "    apply: { model: minecraft:block/missing_multipart, z: 45 }",
      "  }] }",
      "}"
    ], {
      targetPackFormat: { major: 74 },
      resourceExists: () => false
    });

    const lamp = result.units.find(unit => unit.outputPath.endsWith("blockstates/lamp.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("blockstates/fence.json"));
    const variantModelRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north/model")?.sourceRange;
    const variantRotationRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north/x")?.sourceRange;
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0")?.sourceRange;
    const multipartModelRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0/apply/model")?.sourceRange;
    const multipartRotationRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0/apply/z")?.sourceRange;

    assert.ok(variantModelRange);
    assert.ok(variantRotationRange);
    assert.ok(multipartRange);
    assert.ok(multipartModelRange);
    assert.ok(multipartRotationRange);
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateRotation")?.range,
      variantRotationRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_variant"))?.range,
      variantModelRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateWhenValue")?.range,
      multipartRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation")?.range,
      multipartRotationRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_multipart"))?.range,
      multipartModelRange
    );
  });
});
