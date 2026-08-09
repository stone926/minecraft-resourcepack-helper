import * as assert from "node:assert/strict";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource } from "./helpers/compile";

describe("RSGL output conflicts", () => {
  it("reports output conflicts across compiled RSGL files", () => {
    const firstFile = path.resolve("pack", "first.rsgl");
    const secondFile = path.resolve("pack", "second.rsgl");
    const result = compileRsglProgram([
      {
        fileName: firstFile,
        module: parseRsgl("model block stone impl minecraft:block/cube_all(all: minecraft:block/stone) {}")
      },
      {
        fileName: secondFile,
        module: parseRsgl("model block stone { parent minecraft:block/cube_all }")
      }
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
  });

  it("reports output path conflicts", () => {
    const result = compileSource([
      "model block stone impl minecraft:block/cube_all(all: minecraft:block/stone) {}",
      "model block stone { parent minecraft:block/cube_all }"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
  });
});
