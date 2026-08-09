import * as assert from "node:assert/strict";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits
} from "./helpers/compile";

describe("RSGL template expansion", () => {
  it("expands local templates with positional, named, and default arguments", () => {
    const result = compileSourceWithUncheckedExterns([
      "template cube(id: TextureId, texture: TextureId = id) {",
      "  model block id {",
      "    parent minecraft:block/cube_all",
      "    textures { all: texture }",
      "  }",
      "}",
      "use cube(stone, texture: minecraft:block/stone)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
  });

  it("reports recursive template expansion during compilation", () => {
    const result = compileSourceWithUncheckedExterns([
      "template a() {",
      "  use b()",
      "}",
      "template b() {",
      "  use a()",
      "}",
      "use a()"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.templateRecursion"));
    assert.deepStrictEqual(generatedResourceUnits(result), []);
  });

  it("does not generate resources from modules with syntax errors", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block valid {",
      "  parent minecraft:block/cube_all",
      "}",
      "blockstate variants minecraft:invalid {",
      "  case { age: 0 } =>",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.deepStrictEqual(generatedResourceUnits(result), []);
    assert.ok(codes.includes("rsgl.expectedBlockstateModel"));
    assert.strictEqual(codes.includes("rsgl.undefinedSymbol"), false);
  });

  it("expands local resource body templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "template cubeFields(parentModel: ModelId, texture: TextureId = minecraft:block/stone) -> model {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}",
      "model block stone {",
      "  use cubeFields(minecraft:block/cube_all)",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
  });

  it("reports invalid template call arguments during compilation", () => {
    const result = compileSourceWithUncheckedExterns([
      "template cube(id: TextureId, texture: TextureId = id) {",
      "  model block id { parent minecraft:block/cube_all }",
      "}",
      "use cube(",
      "  stone,",
      "  minecraft:block/stone,",
      "  minecraft:block/granite,",
      "  id: dirt,",
      "  extra: minecraft:block/x,",
      "  extra: minecraft:block/y",
      ")"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
    assert.ok(codes.includes("rsgl.compileUnknownArgument"));
    assert.ok(codes.includes("rsgl.compileTooManyArguments"));
    assert.ok(codes.includes("rsgl.compileDuplicateArgument"));
  });

  it("reports invalid template call arguments during compilation", () => {
    const result = compileSourceWithUncheckedExterns([
      "template cubeFields(parentModel: ModelId, texture: TextureId) -> model {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}",
      "model block bad {",
      "  use cubeFields()",
      "  use cubeFields(",
      "    minecraft:block/cube_all,",
      "    minecraft:block/stone,",
      "    minecraft:block/extra,",
      "    texture: minecraft:block/dirt,",
      "    extra: true",
      "  )",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.missingArgument"));
    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
    assert.ok(codes.includes("rsgl.compileMissingArgument"));
    assert.ok(codes.includes("rsgl.compileUnknownArgument"));
    assert.ok(codes.includes("rsgl.compileTooManyArguments"));
    assert.ok(codes.includes("rsgl.compileDuplicateArgument"));
  });
});
