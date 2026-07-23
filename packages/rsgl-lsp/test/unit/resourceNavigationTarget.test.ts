import * as assert from "node:assert";
import * as path from "node:path";
import {
  compileRsglResourceAnalysis,
  parseRsgl
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

  it("keeps inherited lookup effective when a lower physical layer wins", () => {
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

    assert.ok(selections.some(selection =>
      selection.target.kind === "texture"
      && selection.target.id === "demo:block/fallback"
      && selection.resolutionScope === "effective"
      && selection.declarationMode === "checked"
    ));
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
