import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile } from "../../src/compiler";
import { compileSource, expectNoDiagnostics } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL merge fragments and raw JSON", () => {
  it("preserves empty list expressions in resource raw json", () => {
    const result = compileSource([
      "atlas blocks {",
      "  raw_json { sources: [] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "atlas")?.content, {
      sources: []
    });
  });

  it("records nested source map entries for raw json fragments", () => {
    const result = compileSource([
      "item tinted {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [{ type: minecraft:constant, value: [1, 0.5, 0] }]",
      "    }",
      "  }",
      "}"
    ], { fileName: path.resolve("pack", "main.rsgl") });

    expectNoDiagnostics(result);
    const paths = result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath);
    assert.ok(paths.includes("/model/type"));
    assert.ok(paths.includes("/model/tints/0/type"));
    assert.ok(paths.includes("/model/tints/0/value/1"));
  });

  it("enforces override create and append merge semantics in resource bodies", () => {
    const result = compileSource([
      "model block patched {",
      "  parent minecraft:block/cube_all",
      "  textures { all minecraft:block/stone }",
      "  layers [{ texture: minecraft:block/base }]",
      "  override { parent: minecraft:block/overridden }",
      "  override create { display: { gui: { scale: [1, 1, 1] } } }",
      "  append { textures: { particle: minecraft:block/stone } }",
      "  append { layers: [{ texture: minecraft:block/overlay }] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/overridden",
      textures: {
        all: "minecraft:block/stone",
        particle: "minecraft:block/stone"
      },
      layers: [
        { texture: "minecraft:block/base" },
        { texture: "minecraft:block/overlay" }
      ],
      display: {
        gui: {
          scale: [1, 1, 1]
        }
      }
    });
  });

  it("reports invalid override and append fragments", () => {
    const result = compileSource([
      "model block invalid {",
      "  parent minecraft:block/cube_all",
      "  override { textures: { all: minecraft:block/stone } }",
      "  append { parent: minecraft:block/other }",
      "  raw_json 1",
      "  override 2",
      "  append 3",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.overrideMissingField"));
    assert.ok(codes.includes("rsgl.appendIncompatibleField"));
    assert.ok(codes.includes("rsgl.invalidRawJsonFragment"));
    assert.ok(codes.includes("rsgl.invalidOverrideFragment"));
    assert.ok(codes.includes("rsgl.invalidAppendFragment"));
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all"
    });
  });

  it("applies override create and append semantics in blockstate bodies", () => {
    const result = compileSource([
      "blockstate lamp {",
      "  variants {",
      "    { facing: north } -> { model: minecraft:block/lamp, x: 0 }",
      "  }",
      "  override { variants: { \"facing=north\": { model: minecraft:block/lamp_changed } } }",
      "  override create { variants: { \"facing=south\": { model: minecraft:block/lamp_south } } }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    apply { model: minecraft:block/fence_post }",
      "  }",
      "  append { multipart: [{ when: { north: true }, apply: { model: minecraft:block/fence_side } }] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: {
          model: "minecraft:block/lamp_changed",
          x: 0
        },
        ["facing=south"]: {
          model: "minecraft:block/lamp_south"
        }
      }
    });

    const fence = result.units.find(unit => unit.outputPath.endsWith("fence.json"));
    assert.deepStrictEqual(fence?.content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/fence_post"
          }
        },
        {
          apply: {
            model: "minecraft:block/fence_side"
          },
          when: {
            north: true
          }
        }
      ]
    });
    assert.ok(fence?.sourceMap.mappings.some(mapping => mapping.generatedPath === "/multipart/1"));
  });

  it("reports invalid blockstate override and append fragments", () => {
    const result = compileSource([
      "blockstate invalid_variants {",
      "  variants {",
      "    {} -> { model: minecraft:block/base }",
      "  }",
      "  override { variants: { \"facing=north\": { model: minecraft:block/new } } }",
      "  append { variants: { \"facing=south\": { model: minecraft:block/south } } }",
      "  raw_json 1",
      "  override 2",
      "  append 3",
      "}",
      "blockstate invalid_multipart {",
      "  multipart {",
      "    apply { model: minecraft:block/post }",
      "  }",
      "  append { multipart: { apply: { model: minecraft:block/side } } }",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.overrideMissingField"));
    assert.ok(codes.includes("rsgl.appendIncompatibleField"));
    assert.ok(codes.includes("rsgl.invalidRawJsonFragment"));
    assert.ok(codes.includes("rsgl.invalidOverrideFragment"));
    assert.ok(codes.includes("rsgl.invalidAppendFragment"));
    assert.ok(codes.includes("rsgl.invalidBlockstateMultipartFragment"));

    const invalidVariants = result.units.find(unit => unit.outputPath.endsWith("invalid_variants.json"));
    assert.deepStrictEqual(invalidVariants?.content, {
      variants: {
        [""]: {
          model: "minecraft:block/base"
        }
      }
    });
    const invalidMultipart = result.units.find(unit => unit.outputPath.endsWith("invalid_multipart.json"));
    assert.deepStrictEqual(invalidMultipart?.content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/post"
          }
        }
      ]
    });
  });

  it("loads raw_json_file path fragments relative to RSGL source files", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const fragmentsDir = path.join(packDir, "fragments");
      const mainFile = path.join(packDir, "main.rsgl");
      const valuesFile = path.join(packDir, "values.rsgl");
      fs.mkdirSync(fragmentsDir, { recursive: true });
      fs.writeFileSync(path.join(fragmentsDir, "model.json"), JSON.stringify({
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/stone"
        },
        ambientocclusion: false
      }));
      fs.writeFileSync(path.join(fragmentsDir, "item.json"), JSON.stringify({
        model: "minecraft:item/diamond",
        ["hand_animation_on_swap"]: false
      }));
      fs.writeFileSync(valuesFile, [
        "let itemFragment = raw_json_file(\"./fragments/item.json\")",
        "export { itemFragment }"
      ].join("\n"));
      fs.writeFileSync(mainFile, [
        "import { itemFragment } from \"./values.rsgl\"",
        "model block custom_panel {",
        "  raw_json_file(\"./fragments/model.json\")",
        "  raw_json(\"{\\\"ambientocclusion\\\":false}\")",
        "}",
        "item diamond {",
        "  raw_json itemFragment",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile);

      expectNoDiagnostics(result);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/items/diamond.json",
        "assets/minecraft/models/block/custom_panel.json"
      ]);
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("custom_panel.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/stone"
        },
        ambientocclusion: false
      });
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("diamond.json"))?.content, {
        ["hand_animation_on_swap"]: false,
        model: {
          type: "minecraft:model",
          model: "minecraft:item/diamond"
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports raw_json path load and parse errors", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(path.join(root, "invalid.json"), "{");
      fs.writeFileSync(mainFile, [
        "model block missing {",
        "  raw_json(\"./missing.json\")",
        "}",
        "model block invalid {",
        "  raw_json(\"./invalid.json\")",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile);
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.rawJsonLoadFailed"));
      assert.ok(codes.includes("rsgl.rawJsonParseFailed"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
