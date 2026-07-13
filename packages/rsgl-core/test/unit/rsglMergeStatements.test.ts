import * as assert from "node:assert";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits
} from "./helpers/compile";

describe("RSGL merge statements", () => {
  it("compiles all merge modes through the generic resource body engine", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block patched {",
      "  parent minecraft:block/base",
      "  textures { all: minecraft:block/stone }",
      "  layers [{ texture: minecraft:block/base }]",
      "  merge strict { parent: minecraft:block/changed }",
      "  merge upsert { display: { gui: { scale: [1, 1, 1] } } }",
      "  merge append {",
      "    textures: { particle: minecraft:block/stone },",
      "    layers: [{ texture: minecraft:block/overlay }]",
      "  }",
      "  merge deep { display: { gui: { rotation: [0, 0, 0] } } }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/changed",
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
          scale: [1, 1, 1],
          rotation: [0, 0, 0]
        }
      }
    });
  });

  it("uses the new merge diagnostics", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block invalid {",
      "  parent minecraft:block/base",
      "  merge strict { textures: { all: minecraft:block/stone } }",
      "  merge append { parent: minecraft:block/changed }",
      "  merge 1",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.mergeFieldNotFound"));
    assert.ok(codes.includes("rsgl.mergeAppendIncompatibleField"));
    assert.ok(codes.includes("rsgl.invalidMergeFragment"));
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/base"
    });
  });

  it("deep-merges template, if, and for fragments with array mapping offsets", () => {
    const result = compileSourceWithUncheckedExterns([
      "template addTexture(key: String, texture: TextureId) -> model {",
      "  merge { textures: { [key]: texture } }",
      "}",
      "model block generated {",
      "  textures { all: minecraft:block/stone }",
      "  layers []",
      "  use addTexture(\"particle\", minecraft:block/particle)",
      "  if true {",
      "    merge { display: { gui: { scale: [1, 1, 1] } } }",
      "  }",
      "  for texture in [minecraft:block/base, minecraft:block/overlay] {",
      "    merge { layers: [{ texture: texture }] }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      textures: {
        all: "minecraft:block/stone",
        particle: "minecraft:block/particle"
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
    assert.ok(mappingPaths.includes("/layers/0/texture"));
    assert.ok(mappingPaths.includes("/layers/1/texture"));
  });
});
