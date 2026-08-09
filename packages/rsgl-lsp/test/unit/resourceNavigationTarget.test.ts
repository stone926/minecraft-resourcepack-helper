import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  compileRsglResourceAnalysis,
  parseRsgl,
  type JsonValue
} from "../../../rsgl-core/src";
import { resourceNavigationTargetsAtOffset } from "../../src/resourceNavigationTarget";

describe("RSGL host resource navigation target selection", () => {
  it("retains local/custom/vanilla scope and checked state from compiler facts", () => {
    for (const scope of ["local", "custom", "vanilla"] as const) {
      const source = [
        `extern ${scope} model demo:block/base`,
        "model block child {",
        "  parent demo:block/base",
        "}"
      ].join("\n");
      const fileName = path.resolve(`scope-${scope}.rsgl`);
      const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
        externResourceResolution: () => ({ resolvedPath: null, candidatePaths: [] })
      });
      const offset = source.lastIndexOf("demo:block/base") + 3;
      assert.deepStrictEqual(resourceNavigationTargetsAtOffset(analysis, fileName, offset), [{
        target: { kind: "model", id: "demo:block/base" },
        resolutionScope: scope,
        declarationMode: "checked"
      }]);
    }
  });

  it("marks extern! as unchecked instead of inventing a physical location", () => {
    const source = [
      "extern! vanilla model minecraft:block/cube_all",
      "model block child {",
      "  parent minecraft:block/cube_all",
      "}"
    ].join("\n");
    const fileName = path.resolve("unchecked.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }]);
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(
        analysis,
        fileName,
        source.lastIndexOf("minecraft:block/cube_all") + 3
      ),
      [{
        target: { kind: "model", id: "minecraft:block/cube_all" },
        resolutionScope: "vanilla",
        declarationMode: "unchecked"
      }]
    );
  });

  it("does not make inherited model dependencies selectable at the parent literal", () => {
    const source = [
      "extern local model demo:block/parent",
      "model block child { parent demo:block/parent }"
    ].join("\n");
    const fileName = path.resolve("inherited-effective.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, kind, id) => ({
        resolvedPath: kind === "model" && id === "demo:block/parent"
          ? path.resolve("local-parent.json")
          : null,
        candidatePaths: []
      }),
      externResourceContent: (_source, kind, id) =>
        kind === "model" && id === "demo:block/parent"
          ? { textures: { all: "demo:block/fallback" } }
          : undefined,
      resourceResolution: (kind, id) => ({
        resolvedPath: kind === "texture" && id === "demo:block/fallback"
          ? path.resolve("vanilla-fallback.png")
          : null,
        candidatePaths: [],
        source: "vanilla"
      })
    });
    const selections = resourceNavigationTargetsAtOffset(
      analysis,
      fileName,
      source.lastIndexOf("demo:block/parent") + 3
    );

    assert.deepStrictEqual(selections, [{
      target: { kind: "model", id: "demo:block/parent" },
      resolutionScope: "local",
      declarationMode: "checked"
    }]);
    assert.ok(analysis.resourceReferences.some(reference =>
      reference.targetKind === "texture"
      && reference.id === "demo:block/fallback"
      && reference.origin === "inherited"
    ), "transitive dependencies remain available to snapshots and reference indexes");
  });

  it("selects the written parent argument without child texture-variable pollution", () => {
    const source = [
      "extern local model demo:block/note_surface",
      "extern local model demo:block/block",
      "extern local texture demo:block/note_block_harp",
      "template noteOverlayModel(parentModel: ModelId) {",
      "  model block note_block_harp {",
      "    parent parentModel",
      "    textures { all: demo:block/note_block_harp }",
      "  }",
      "}",
      "use noteOverlayModel(demo:block/note_surface)"
    ].join("\n");
    const fileName = path.resolve("navigation-template-parent.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.json`),
        candidatePaths: []
      }),
      externResourceContent: (_source, kind, id): JsonValue | undefined => {
        if (kind !== "model") {
          return undefined;
        }
        if (id === "demo:block/note_surface") {
          return {
            parent: "demo:block/block",
            elements: [{ faces: { north: { texture: "#all" } } }]
          };
        }
        return {};
      }
    });
    const parentArgument = source.lastIndexOf("demo:block/note_surface");
    const textureLiteral = source.indexOf("demo:block/note_block_harp", source.indexOf("textures"));

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, parentArgument + 3),
      [{
        target: { kind: "model", id: "demo:block/note_surface" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, textureLiteral + 3),
      [{
        target: { kind: "texture", id: "demo:block/note_block_harp" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
  });

  it("uses the exact resource value and selected conditional branch ranges", () => {
    const source = [
      "extern local model minecraft:block/lectern/lectern_parent",
      "extern local model minecraft:block/note_block_powered",
      "extern vanilla texture minecraft:block/mangrove_planks",
      "extern vanilla texture minecraft:block/oak_planks",
      "for powered in [false, true] {",
      "  model block `lectern_${powered}` {",
      "    parent block/lectern/lectern_parent",
      "    textures {",
      "      wood: powered ? block/mangrove_planks : block/oak_planks",
      "    }",
      "  }",
      "}",
      "blockstate multipart note_block {",
      "  part when $state.powered => block/note_block_powered",
      "}"
    ].join("\n");
    const fileName = path.resolve("navigation-conditional-values.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.json`),
        candidatePaths: []
      }),
      externResourceContent: () => ({})
    });
    const parentKeyword = source.indexOf("parent block/lectern");
    const parentStart = source.indexOf("block/lectern/lectern_parent", parentKeyword);
    const conditionStart = source.indexOf("powered ?");
    const mangroveStart = source.indexOf("block/mangrove_planks", conditionStart);
    const oakStart = source.indexOf("block/oak_planks", conditionStart);
    const poweredModelStart = source.indexOf("block/note_block_powered", oakStart);

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, parentStart + 2),
      [{
        target: { kind: "model", id: "minecraft:block/lectern/lectern_parent" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, parentKeyword + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, conditionStart + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, mangroveStart + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/mangrove_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, oakStart + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/oak_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, poweredModelStart + 2),
      [{
        target: { kind: "model", id: "minecraft:block/note_block_powered" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
  });

  it("preserves selected conditional ranges through lexical bindings", () => {
    const source = [
      "extern vanilla texture minecraft:block/mangrove_planks",
      "extern vanilla texture minecraft:block/oak_planks",
      "for powered in [false, true] {",
      "  let wood: TextureId = powered ? block/mangrove_planks : block/oak_planks",
      "  model block `bound_${powered}` { textures { all: wood } }",
      "}"
    ].join("\n");
    const fileName = path.resolve("navigation-bound-conditional.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.png`),
        candidatePaths: []
      })
    });
    const conditionStart = source.indexOf("powered ?");
    const mangroveStart = source.indexOf("block/mangrove_planks", conditionStart);
    const oakStart = source.indexOf("block/oak_planks", conditionStart);

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, conditionStart + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, mangroveStart + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/mangrove_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, oakStart + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/oak_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
  });

  it("preserves selected conditional ranges through template arguments and defaults", () => {
    const source = [
      "extern vanilla texture minecraft:block/mangrove_planks",
      "extern vanilla texture minecraft:block/oak_planks",
      "template withWood(name: Json, wood: TextureId = false ? block/mangrove_planks : block/oak_planks) {",
      "  model block `template_${name}` { textures { all: wood } }",
      "}",
      "use withWood(\"explicit\", true ? block/mangrove_planks : block/oak_planks)",
      "use withWood(\"default\")"
    ].join("\n");
    const fileName = path.resolve("navigation-template-conditional.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.png`),
        candidatePaths: []
      })
    });
    const defaultCondition = source.indexOf("false ?");
    const defaultMangrove = source.indexOf("block/mangrove_planks", defaultCondition);
    const defaultOak = source.indexOf("block/oak_planks", defaultCondition);
    const explicitCondition = source.indexOf("true ?");
    const explicitMangrove = source.indexOf("block/mangrove_planks", explicitCondition);
    const explicitOak = source.indexOf("block/oak_planks", explicitCondition);

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, defaultCondition + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, defaultMangrove + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, defaultOak + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/oak_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, explicitCondition + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, explicitMangrove + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/mangrove_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, explicitOak + 2),
      []
    );
  });

  it("preserves selected value locations across module imports", () => {
    const providerSource = [
      "extern vanilla texture minecraft:block/mangrove_planks",
      "extern vanilla texture minecraft:block/oak_planks",
      "let exportedWood: TextureId = true ? block/mangrove_planks : block/oak_planks",
      "export { exportedWood }"
    ].join("\n");
    const consumerSource = [
      "import { exportedWood } from \"./navigation-selection-provider.rsgl\"",
      "model block imported_selection { textures { all: exportedWood } }"
    ].join("\n");
    const providerFile = path.resolve("navigation-selection-provider.rsgl");
    const consumerFile = path.resolve("navigation-selection-consumer.rsgl");
    const analysis = compileRsglResourceAnalysis([
      { fileName: providerFile, module: parseRsgl(providerSource) },
      { fileName: consumerFile, module: parseRsgl(consumerSource) }
    ], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.png`),
        candidatePaths: []
      })
    });
    const conditionStart = providerSource.indexOf("true ?");
    const mangroveStart = providerSource.indexOf("block/mangrove_planks", conditionStart);
    const oakStart = providerSource.indexOf("block/oak_planks", conditionStart);

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, providerFile, conditionStart + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, providerFile, mangroveStart + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/mangrove_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, providerFile, oakStart + 2),
      []
    );
  });

  it("preserves selected value paths through loop destructuring", () => {
    const source = [
      "extern vanilla texture minecraft:block/mangrove_planks",
      "extern vanilla texture minecraft:block/oak_planks",
      "for { name, wood } in [",
      "  { name: \"mangrove\", wood: true ? block/mangrove_planks : block/oak_planks },",
      "  { name: \"oak\", wood: false ? block/mangrove_planks : block/oak_planks }",
      "] {",
      "  model block `loop_${name}` { textures { all: wood } }",
      "}"
    ].join("\n");
    const fileName = path.resolve("navigation-loop-selection.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.png`),
        candidatePaths: []
      })
    });
    const firstCondition = source.indexOf("true ?");
    const firstMangrove = source.indexOf("block/mangrove_planks", firstCondition);
    const firstOak = source.indexOf("block/oak_planks", firstCondition);
    const secondCondition = source.indexOf("false ?", firstOak);
    const secondMangrove = source.indexOf("block/mangrove_planks", secondCondition);
    const secondOak = source.indexOf("block/oak_planks", secondCondition);

    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, firstCondition + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, firstMangrove + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/mangrove_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, firstOak + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, secondCondition + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, secondMangrove + 2),
      []
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, secondOak + 2),
      [{
        target: { kind: "texture", id: "minecraft:block/oak_planks" },
        resolutionScope: "vanilla",
        declarationMode: "checked"
      }]
    );
  });

  it("preserves selected model paths through collection lambdas", () => {
    const source = [
      "extern local model minecraft:block/note_a",
      "extern local model minecraft:block/note_b",
      "let models: List<ModelId> = map([",
      "  true ? block/note_a : block/note_b,",
      "  false ? block/note_a : block/note_b",
      "], model => model)",
      "blockstate multipart notes {",
      "  for model in models {",
      "    part when $state.powered => model",
      "  }",
      "}"
    ].join("\n");
    const fileName = path.resolve("navigation-collection-selection.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (_source, _kind, id) => ({
        resolvedPath: path.resolve(`${id.replaceAll(":", "-")}.json`),
        candidatePaths: []
      }),
      externResourceContent: () => ({})
    });
    const firstCondition = source.indexOf("true ?");
    const firstA = source.indexOf("block/note_a", firstCondition);
    const firstB = source.indexOf("block/note_b", firstCondition);
    const secondCondition = source.indexOf("false ?", firstB);
    const secondA = source.indexOf("block/note_a", secondCondition);
    const secondB = source.indexOf("block/note_b", secondCondition);

    for (const offset of [firstCondition, firstB, secondCondition, secondA]) {
      assert.deepStrictEqual(
        resourceNavigationTargetsAtOffset(analysis, fileName, offset + 2),
        []
      );
    }
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, firstA + 2),
      [{
        target: { kind: "model", id: "minecraft:block/note_a" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
    assert.deepStrictEqual(
      resourceNavigationTargetsAtOffset(analysis, fileName, secondB + 2),
      [{
        target: { kind: "model", id: "minecraft:block/note_b" },
        resolutionScope: "local",
        declarationMode: "checked"
      }]
    );
  });

  it("selects generated declarations for cross-language incoming References", () => {
    const source = "namespace demo\nmodel block generated {}";
    const fileName = path.resolve("generated.rsgl");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }]);
    const start = source.indexOf("generated");
    assert.deepStrictEqual(resourceNavigationTargetsAtOffset(analysis, fileName, start + 2), [{
      target: { kind: "model", id: "demo:block/generated" },
      resolutionScope: "effective",
      declarationMode: "undeclared"
    }]);
  });
});
