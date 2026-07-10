import * as assert from "node:assert";
import { compileSourceWithUncheckedExterns, expectNoDiagnostics, unitByPath } from "./helpers/compile";

describe("RSGL blockstate fragment merge policy", () => {
  it("applies strict and upsert through the shared merge engine", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate lamp {",
      "  variants {",
      "    { facing: north } -> { model: minecraft:block/lamp, x: 0 }",
      "  }",
      "  merge strict {",
      "    variants: { \"facing=north\": { model: minecraft:block/lamp_changed } }",
      "  }",
      "  merge upsert {",
      "    variants: { \"facing=south\": { model: minecraft:block/lamp_south } }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "facing=north": {
          model: "minecraft:block/lamp_changed",
          x: 0
        },
        "facing=south": {
          model: "minecraft:block/lamp_south"
        }
      }
    });
  });

  it("appends multipart entries and offsets their field mappings", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate fence {",
      "  multipart {",
      "    apply { model: minecraft:block/fence_post }",
      "  }",
      "  merge append {",
      "    multipart: [{ when: { north: true }, apply: { model: minecraft:block/fence_side } }]",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    const fence = unitByPath(result, "blockstates/fence.json");
    assert.deepStrictEqual(fence.content, {
      multipart: [
        { apply: { model: "minecraft:block/fence_post" } },
        {
          when: { north: true },
          apply: { model: "minecraft:block/fence_side" }
        }
      ]
    });
    const paths = fence.sourceMap.mappings.map(mapping => mapping.generatedPath);
    assert.ok(paths.includes("/multipart/1"));
    assert.ok(paths.includes("/multipart/1/apply/model"));
  });

  it("rejects append outside multipart and preserves variants/multipart exclusivity", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate invalid {",
      "  variants {",
      "    {} -> { model: minecraft:block/base }",
      "  }",
      "  merge append { variants: { \"powered=true\": { model: minecraft:block/on } } }",
      "  merge upsert { multipart: [] }",
      "}"
    ]);

    assert.strictEqual(
      result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.mergeOperationNotAllowed").length,
      2
    );
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "": { model: "minecraft:block/base" }
      }
    });
  });

  it("preserves arbitrary top-level fields from blockstate template fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "template extra() {",
      "  merge { custom: { enabled: true } }",
      "}",
      "blockstate templated {",
      "  use extra()",
      "  merge deep { variants: { \"powered=true\": { model: minecraft:block/base } } }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "blockstates/templated.json").content, {
      custom: { enabled: true },
      variants: { "powered=true": { model: "minecraft:block/base" } }
    });
  });
});
