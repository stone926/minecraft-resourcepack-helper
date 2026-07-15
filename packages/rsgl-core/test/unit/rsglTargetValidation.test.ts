import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglModule, compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource } from "./helpers/compile";

describe("RSGL target validation", () => {
  it("uses RSGL target declarations for version-gated validation", () => {
    const result = compileSource([
      "target java format [74, 0]",
      "blockstate variants rotated {",
      "  case * => minecraft:block/rotated with { z: 90 }",
      "}",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block rotated { parent minecraft:block/cube_all }",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
  });

  it("resolves RSGL Minecraft version targets to pack formats", () => {
    const modern = compileSource([
      "target java mc \"1.21.11\"",
      "blockstate variants rotated {",
      "  case * => minecraft:block/rotated with { z: 90 }",
      "}"
    ]);
    const older = compileSource([
      "target java mc \"1.21.10\"",
      "blockstate variants rotated {",
      "  case * => minecraft:block/rotated with { z: 90 }",
      "}"
    ]);

    assert.strictEqual(modern.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"), false);
    assert.ok(older.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"));
  });

  it("reports invalid and conflicting RSGL target formats", () => {
    const invalid = compileRsglModule(parseRsgl("target java format \"newest\""));
    assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidTargetFormat"));

    const invalidMinecraftVersion = compileRsglModule(parseRsgl("target java mc 1"));
    assert.ok(invalidMinecraftVersion.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidTargetMinecraftVersion"));

    const unknownMinecraftVersion = compileRsglModule(parseRsgl("target java mc \"1.99.0\""));
    assert.ok(unknownMinecraftVersion.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unknownTargetMinecraftVersion"));

    const firstFile = path.resolve("pack", "first.rsgl");
    const secondFile = path.resolve("pack", "second.rsgl");
    const conflicting = compileRsglProgram([
      {
        fileName: firstFile,
        module: parseRsgl("target java format [88, 0]")
      },
      {
        fileName: secondFile,
        module: parseRsgl("target java format [89, 0]")
      }
    ]);

    assert.ok(conflicting.diagnostics.some(diagnostic => diagnostic.code === "rsgl.conflictingTargetFormat"));
  });
});
