import * as assert from "node:assert";
import { type JsonValue } from "../../src/compiler";
import { compileSource } from "./helpers/compile";

describe("RSGL model validation", () => {
  it("validates model display, element geometry, rotation, and face fields", () => {
    const valid = compileSource([
      "extern! vanilla texture minecraft:block/stone",
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
    ]);
    const validCodes = valid.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementVector"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelElementCoordinateOutOfRange"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceTexture"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceRotation"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelDisplayContext"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementRotationAxis"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelFaceUvOutOfRange"), false);

    const invalid = compileSource([
      "extern! vanilla texture minecraft:block/stone",
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
    ]);
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

  it("validates generated model parent chains and texture variables", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern! custom texture minecraft:block/inherited_texture",
      "extern custom texture minecraft:block/missing_texture",
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
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return id !== "minecraft:block/missing_texture";
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_texture"));
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

  it("uses extern var for direct and aliased missing variables without emitting it into model JSON", () => {
    const result = compileSource([
      "model block declared_variables {",
      "  extern var #front",
      "  textures { all: \"#front\", particle: \"#all\" }",
      "}",
      "model block undeclared_variable {",
      "  textures { all: \"#front\" }",
      "}"
    ]);

    const unresolved = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.unresolvedTextureVariable"
    );
    assert.strictEqual(unresolved.length, 1);
    assert.strictEqual(unresolved[0].severity, "warning");

    const undeclaredUnit = result.units.find(unit => unit.outputPath.endsWith("undeclared_variable.json"));
    const undeclaredRange = undeclaredUnit?.sourceMap.mappings.find(mapping =>
      mapping.generatedPath === "/textures/all"
    )?.sourceRange;
    assert.deepStrictEqual(unresolved[0].range, undeclaredRange);

    const declaredUnit = result.units.find(unit => unit.outputPath.endsWith("declared_variables.json"));
    assert.deepStrictEqual(declaredUnit?.content, {
      textures: {
        all: "#front",
        particle: "#all"
      }
    });
    assert.strictEqual(JSON.stringify(declaredUnit?.content).includes("extern"), false);
  });

  it("does not let extern var suppress variable cycles or missing resolved textures", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom texture minecraft:block/missing_texture",
      "model block guarded_validation {",
      "  extern var #front, #a, #existing",
      "  textures {",
      "    a: \"#b\",",
      "    b: \"#a\",",
      "    existing: minecraft:block/missing_texture,",
      "    resolved: \"#existing\",",
      "    unresolved: \"#front\"",
      "  }",
      "}"
    ], {
      externResourceExists: (source, kind, id) => {
        checkedResources.push(`${source}:${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.textureVariableCycle"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.strictEqual(codes.includes("rsgl.unresolvedTextureVariable"), false);
    assert.ok(checkedResources.includes("custom:texture:minecraft:block/missing_texture"));
  });

  it("keeps extern var scoped to its declaring model across siblings and parent chains", () => {
    const result = compileSource([
      "model block declaring_parent {",
      "  extern var #slot",
      "  textures { all: \"#slot\" }",
      "}",
      "model block child_without_declaration {",
      "  parent minecraft:block/declaring_parent",
      "  textures { all: \"#slot\" }",
      "}",
      "model block sibling_without_declaration {",
      "  textures { all: \"#slot\" }",
      "}",
      "model block parent_without_declaration {",
      "  textures { all: \"#child_slot\" }",
      "}",
      "model block child_with_declaration {",
      "  parent minecraft:block/parent_without_declaration",
      "  extern var #child_slot",
      "  textures { all: \"#child_slot\" }",
      "}"
    ]);

    const unresolvedRanges = result.diagnostics
      .filter(diagnostic => diagnostic.code === "rsgl.unresolvedTextureVariable")
      .map(diagnostic => diagnostic.range)
      .sort((left, right) => left.start - right.start);
    const expectedRanges = [
      "child_without_declaration.json",
      "sibling_without_declaration.json",
      "parent_without_declaration.json"
    ].map(outputPath => result.units
      .find(unit => unit.outputPath.endsWith(outputPath))
      ?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/all")
      ?.sourceRange
    );
    assert.ok(expectedRanges.every(range => range !== undefined));
    assert.deepStrictEqual(
      unresolvedRanges,
      expectedRanges
        .filter((range): range is { start: number; end: number } => range !== undefined)
        .sort((left, right) => left.start - right.start)
    );
  });

  it("stops model parent validation at virtual vanilla builtin models", () => {
    const checkedResources: string[] = [];
    const loadedModels: string[] = [];
    const externalModels = new Map<string, JsonValue>([
      ["minecraft:item/generated", {
        parent: "minecraft:builtin/generated"
      }]
    ]);
    const result = compileSource([
      "extern! custom model minecraft:item/generated",
      "extern custom model minecraft:block/missing_parent",
      "model item generated_parent {",
      "  parent minecraft:item/generated",
      "}",
      "model block missing_child {",
      "  parent minecraft:block/missing_parent",
      "}"
    ], {
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
    const result = compileSource([
      "extern! custom model minecraft:block/external_child, minecraft:block/external_cycle_a",
      "extern custom model minecraft:block/external_missing_child",
      "model block child_external {",
      "  parent minecraft:block/external_child",
      "  textures { all: \"#alias\" }",
      "}",
      "model block cycle_external { parent minecraft:block/external_cycle_a }",
      "model block missing_external { parent minecraft:block/external_missing_child }"
    ], {
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
});
