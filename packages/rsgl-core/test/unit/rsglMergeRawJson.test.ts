import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile } from "../../src/compiler";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits,
  withUncheckedExterns
} from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL merge fragments and base documents", () => {
  it("preserves empty list expressions in resource merges", () => {
    const result = compileSourceWithUncheckedExterns([
      "atlas blocks {",
      "  merge { sources: [] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.kind === "atlas")?.content, {
      sources: []
    });
  });

  it("records nested source map entries for merge fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "item tinted {",
      "  merge {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [{ type: minecraft:constant, value: [1, 0.5, 0] }]",
      "    }",
      "  }",
      "}"
    ], { fileName: path.resolve("pack", "main.rsgl") });

    expectNoDiagnostics(result);
    const paths = generatedResourceUnits(result)[0].sourceMap.mappings.map(mapping => mapping.generatedPath);
    assert.ok(paths.includes("/model/type"));
    assert.ok(paths.includes("/model/tints/0/type"));
    assert.ok(paths.includes("/model/tints/0/value/1"));
  });

  it("enforces strict, upsert, and append semantics in resource bodies", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block patched {",
      "  parent minecraft:block/cube_all",
      "  textures { all minecraft:block/stone }",
      "  layers [{ texture: minecraft:block/base }]",
      "  merge strict { parent: minecraft:block/overridden }",
      "  merge upsert { display: { gui: { scale: [1, 1, 1] } } }",
      "  merge append { textures: { particle: minecraft:block/stone } }",
      "  merge append { layers: [{ texture: minecraft:block/overlay }] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
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
    const mappingPaths = generatedResourceUnits(result)[0].sourceMap.mappings.map(mapping => mapping.generatedPath);
    assert.ok(mappingPaths.includes("/layers/1"));
    assert.ok(mappingPaths.includes("/layers/1/texture"));
  });

  it("reports invalid strict, append, and non-object merge fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block invalid {",
      "  parent minecraft:block/cube_all",
      "  merge strict { textures: { all: minecraft:block/stone } }",
      "  merge append { parent: minecraft:block/other }",
      "  merge 1",
      "  merge strict 2",
      "  merge append 3",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.mergeFieldNotFound"));
    assert.ok(codes.includes("rsgl.mergeAppendIncompatibleField"));
    assert.strictEqual(codes.filter(code => code === "rsgl.invalidMergeFragment").length, 3);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/cube_all"
    });
  });

  it("applies strict, upsert, and append semantics in blockstate bodies", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants lamp {",
      "  case { facing: north } => minecraft:block/lamp with { x: 0 }",
      "  merge strict { variants: { \"facing=north\": { model: minecraft:block/lamp_changed } } }",
      "  merge upsert { variants: { \"facing=south\": { model: minecraft:block/lamp_south } } }",
      "}",
      "blockstate multipart fence {",
      "  part always => minecraft:block/fence_post",
      "  merge append { multipart: [{ when: { north: true }, apply: { model: minecraft:block/fence_side } }] }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const lamp = generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("lamp.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: {
          model: "minecraft:block/lamp_changed"
        },
        ["facing=south"]: {
          model: "minecraft:block/lamp_south"
        }
      }
    });

    const fence = generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("fence.json"));
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

  it("reports invalid blockstate merge fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants invalid_variants {",
      "  case * => minecraft:block/base",
      "  merge strict { variants: { \"facing=north\": { model: minecraft:block/new } } }",
      "  merge append { variants: { \"facing=south\": { model: minecraft:block/south } } }",
      "  merge 1",
      "  merge strict 2",
      "  merge append 3",
      "}",
      "blockstate multipart invalid_multipart {",
      "  part always => minecraft:block/post",
      "  merge append { multipart: { apply: { model: minecraft:block/side } } }",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.mergeFieldNotFound"));
    assert.ok(codes.includes("rsgl.mergeOperationNotAllowed"));
    assert.strictEqual(codes.filter(code => code === "rsgl.invalidMergeFragment").length, 3);

    const invalidVariants = generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("invalid_variants.json"));
    assert.deepStrictEqual(invalidVariants?.content, {
      variants: {
        [""]: {
          model: "minecraft:block/base"
        }
      }
    });
    const invalidMultipart = generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("invalid_multipart.json"));
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

  it("loads base documents relative to RSGL source files", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const fragmentsDir = path.join(packDir, "fragments");
      const mainFile = path.join(packDir, "main.rsgl");
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
      fs.writeFileSync(mainFile, [
        "model block custom_panel {",
        "  base \"./fragments/model.json\"",
        "  merge { ambientocclusion: false }",
        "}",
        "item diamond {",
        "  base \"./fragments/item.json\"",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));

      expectNoDiagnostics(result);
      assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
        "assets/minecraft/items/diamond.json",
        "assets/minecraft/models/block/custom_panel.json"
      ]);
      assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("custom_panel.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/stone"
        },
        ambientocclusion: false
      });
      assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("diamond.json"))?.content, {
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

  it("reports base document load and parse errors", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(path.join(root, "invalid.json"), "{");
      fs.writeFileSync(mainFile, [
        "model block missing {",
        "  base \"./missing.json\"",
        "}",
        "model block invalid {",
        "  base \"./invalid.json\"",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.baseLoadFailed"));
      assert.ok(codes.includes("rsgl.baseParseFailed"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
