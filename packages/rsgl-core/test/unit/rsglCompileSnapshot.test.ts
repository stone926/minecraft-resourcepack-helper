import * as assert from "node:assert";
import * as path from "node:path";
import { createRsglCompileSnapshot, type RsglCompileResult } from "../../src/compiler";
import { compileSourceWithUncheckedExterns } from "./helpers/compile";

describe("RSGL compile snapshots", () => {
  it("normalizes internal resources and source-map semantics without character offsets", () => {
    const sourceRoot = path.resolve("fixtures", "snapshot");
    const fileName = path.join(sourceRoot, "nested", "main.rsgl");
    const result = compileSourceWithUncheckedExterns([
      "template cube(id: ResourceId) {",
      "  model block id {",
      "    textures { all: minecraft:block/stone }",
      "    parent minecraft:block/cube_all",
      "  }",
      "}",
      "use cube(snapshot_model)"
    ], { fileName });

    const snapshot = createRsglCompileSnapshot(result, { sourceRoot });

    assert.strictEqual(snapshot.version, 1);
    assert.deepStrictEqual(snapshot.diagnostics, []);
    assert.strictEqual(snapshot.resources.length, 1);
    assert.deepStrictEqual(snapshot.resources[0].content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/stone" }
    });
    assert.strictEqual(snapshot.resources[0].sourceMap.mappings[0].sourceFile, "nested/main.rsgl");
    assert.deepStrictEqual(snapshot.resources[0].sourceMap.mappings[0].expansionStack, ["use cube"]);
    assert.strictEqual("sourceRange" in snapshot.resources[0].sourceMap.mappings[0], false);
  });

  it("excludes external dependency marker units by default", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block snapshot_model { parent minecraft:block/cube_all }"
    ]);

    const snapshot = createRsglCompileSnapshot(result);

    assert.deepStrictEqual(snapshot.resources.map(resource => resource.outputPath), [
      "assets/minecraft/models/block/snapshot_model.json"
    ]);
  });

  it("keeps diagnostic identity portable without embedding path-bearing messages", () => {
    const sourceRoot = path.resolve("fixtures", "snapshot");
    const sharedRoot = path.resolve("fixtures", "shared sources");
    const result: RsglCompileResult = {
      units: [],
      dependencies: [],
      diagnostics: [
        {
          code: "rsgl.example",
          severity: "error",
          message: `Failure in ${path.join(sourceRoot, "nested", "main.rsgl")}`,
          fileName: path.join(sourceRoot, "nested", "main.rsgl"),
          range: { start: 4, end: 8 }
        },
        {
          code: "rsgl.shared",
          severity: "warning",
          message: `Failure in ${path.join(sharedRoot, "common.rsgl")}`,
          fileName: path.join(sharedRoot, "common.rsgl"),
          range: { start: 0, end: 1 }
        }
      ]
    };

    const snapshot = createRsglCompileSnapshot(result, {
      sourceRoot,
      sourceFileAliases: [{ root: sharedRoot, prefix: "<shared>" }]
    });

    assert.deepStrictEqual(snapshot.diagnostics, [
      {
        code: "rsgl.shared",
        severity: "warning",
        fileName: "<shared>/common.rsgl"
      },
      {
        code: "rsgl.example",
        severity: "error",
        fileName: "nested/main.rsgl"
      }
    ]);
  });
});
