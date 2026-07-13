import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { expectNoDiagnostics, generatedResourceUnits, withUncheckedExterns } from "./helpers/compile";

describe("RSGL import semantics", () => {
  it("expands templates imported from another RSGL file", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cube as cubeModel } from \"./templates.rsgl\"",
          "use cubeModel(stone, texture: minecraft:block/stone)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: TextureId, texture: TextureId = id) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: texture }",
          "  }",
          "}"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
    const mapping = units[0].sourceMap.mappings[0];
    assert.strictEqual(mapping.sourceFile, templatesFile);
    assert.strictEqual(mapping.reason, "template");
    assert.deepStrictEqual(mapping.expansionStack.map(frame => frame.label), ["use cubeModel"]);
  });

  it("expands imported resource body templates with definition-file defaults", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import { cubeFields } from \"./fragments.rsgl\"",
          "model block stone {",
          "  parent minecraft:block/cube_all",
          "  use cubeFields()",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "let defaultTexture: TextureId = block/stone",
          "template cubeFields(texture: TextureId = defaultTexture) -> model {",
          "  textures { all: texture }",
          "}",
          "export { cubeFields }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath), [
      "assets/app/models/block/stone.json"
    ]);
    assert.deepStrictEqual(units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "library:block/stone"
      }
    });
  });

  it("maps imported resource body template fields to definition files", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import { modelFields, textureLayer } from \"./fragments.rsgl\"",
          "model block mapped {",
          "  use modelFields(minecraft:block/cube_all)",
          "  textures {",
          "    use textureLayer(\"layer/zero\", minecraft:block/stone)",
          "  }",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "template modelFields(parentModel: ModelId) -> model {",
          "  parent parentModel",
          "}",
          "template textureLayer(key: String, texture: TextureId) -> model {",
          "  merge { [key]: texture }",
          "}",
          "export { modelFields, textureLayer }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        ["layer/zero"]: "minecraft:block/stone"
      }
    });
    assert.deepStrictEqual(units[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/layer~1zero"
    ]);

    const parentMapping = units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/parent");
    assert.strictEqual(parentMapping?.sourceFile, fragmentsFile);
    assert.strictEqual(parentMapping?.reason, "template");
    assert.deepStrictEqual(parentMapping?.expansionStack.map(frame => frame.label), ["use modelFields"]);

    const texturesMapping = units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures");
    assert.strictEqual(texturesMapping?.sourceFile, mainFile);
    assert.strictEqual(texturesMapping?.reason, "direct");

    const layerMapping = units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/layer~1zero");
    assert.strictEqual(layerMapping?.sourceFile, fragmentsFile);
    assert.strictEqual(layerMapping?.reason, "template");
    assert.deepStrictEqual(layerMapping?.expansionStack.map(frame => frame.label), ["use textureLayer"]);
  });

  it("preserves imported template environments inside resource body loops", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import { generatedLayers } from \"./fragments.rsgl\"",
          "model item layered {",
          "  use generatedLayers()",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "template textureLayer(texture: TextureId) -> model {",
          "  textures { layer0: texture }",
          "}",
          "template generatedLayers(textures: Json = [block/stone, block/dirt]) -> model {",
          "  parent minecraft:item/generated",
          "  for texture in textures {",
          "    use textureLayer(texture)",
          "  }",
          "}",
          "export { generatedLayers }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath), [
      "assets/app/models/item/layered.json"
    ]);
    assert.deepStrictEqual(units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "library:block/dirt"
      }
    });
  });

  it("expands imported blockstate section templates with definition-file defaults", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import { connectedPane, lampFacing } from \"./fragments.rsgl\"",
          "blockstate variants lamp {",
          "  use lampFacing()",
          "}",
          "blockstate multipart pane {",
          "  apply { model: minecraft:block/pane_post }",
          "  use connectedPane()",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "let defaultModel: ModelId = block/lamp",
          "template lampFacing(modelId: ModelId = defaultModel) -> variants {",
          "    { facing: north }: { model: modelId }",
          "}",
          "template connectedPane(side: ModelId = block/pane_side) -> multipart {",
          "    for facing in [north, east] {",
          "      when { [facing]: true } apply { model: side, y: yaw(facing) }",
          "    }",
          "}",
          "export { connectedPane, lampFacing }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath).sort(), [
      "assets/app/blockstates/lamp.json",
      "assets/app/blockstates/pane.json"
    ]);

    const lamp = units.find(unit => unit.outputPath.endsWith("lamp.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: { model: "library:block/lamp" }
      }
    });
    assert.deepStrictEqual(lamp?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/variants/facing=north",
      "/variants/facing=north/model",
      "/variants"
    ]);
    const lampVariant = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north");
    assert.strictEqual(lampVariant?.sourceFile, fragmentsFile);
    assert.strictEqual(lampVariant?.reason, "template");
    assert.deepStrictEqual(lampVariant?.expansionStack.map(frame => frame.label), ["use lampFacing"]);

    const pane = units.find(unit => unit.outputPath.endsWith("pane.json"));
    assert.deepStrictEqual(pane?.content, {
      multipart: [
        { apply: { model: "minecraft:block/pane_post" } },
        { apply: { model: "library:block/pane_side", y: 0 }, when: { north: true } },
        { apply: { model: "library:block/pane_side", y: 90 }, when: { east: true } }
      ]
    });
    assert.deepStrictEqual(pane?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/multipart/0",
      "/multipart/0/apply",
      "/multipart/0/apply/model",
      "/multipart/1",
      "/multipart/1/apply",
      "/multipart/1/apply/model",
      "/multipart/1/apply/y",
      "/multipart/1/when",
      "/multipart/2",
      "/multipart/2/apply",
      "/multipart/2/apply/model",
      "/multipart/2/apply/y",
      "/multipart/2/when",
      "/multipart"
    ]);
    const paneFragmentMappings = pane?.sourceMap.mappings.filter(mapping =>
      mapping.generatedPath === "/multipart/1" || mapping.generatedPath === "/multipart/2"
    ) ?? [];
    assert.deepStrictEqual(paneFragmentMappings.map(mapping => mapping.sourceFile), [fragmentsFile, fragmentsFile]);
    assert.deepStrictEqual(paneFragmentMappings.map(mapping => mapping.reason), ["template", "template"]);
    assert.ok(paneFragmentMappings.every(mapping => mapping.expansionStack.some(frame => frame.label === "use connectedPane")));
  });

  it("imports exported templates from bare import modules", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import \"./fragments.rsgl\"",
          "blockstate variants lamp {",
          "  use keyed(\"tilt\", `minecraft:block/${\"lamp\"}`)",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "template keyed(property: String, modelId: ModelId) -> variants {",
          "    { [property]: full }: modelId",
          "}",
          "export { keyed }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units[0].content, {
      variants: {
        ["tilt=full"]: { model: "minecraft:block/lamp" }
      }
    });
  });

  it("expands imported templates with their definition-file closure", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace caller",
          "import { woodCube } from \"./templates.rsgl\"",
          "use woodCube(oak_planks)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "namespace custom",
          "import { woods } from \"./tables.rsgl\"",
          "let parentModel: ModelId = block/cube_all",
          "template cube(id: ResourceId, texture: TextureId = woods.acacia) {",
          "  model block id {",
          "    parent parentModel",
          "    textures { all: texture }",
          "  }",
          "}",
          "template woodCube(id: ResourceId) {",
          "  use cube(id)",
          "}"
        ].join("\n"))
      },
      {
        fileName: tablesFile,
        module: parseRsgl([
          "namespace textures",
          "table woods {",
          "  acacia: texture_id(block/acacia_planks)",
          "}"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath), [
      "assets/caller/models/block/oak_planks.json"
    ]);
    assert.deepStrictEqual(units[0].content, {
      parent: "custom:block/cube_all",
      textures: {
        all: "textures:block/acacia_planks"
      }
    });
    const mapping = units[0].sourceMap.mappings[0];
    assert.strictEqual(mapping.sourceFile, templatesFile);
    assert.deepStrictEqual(mapping.expansionStack.map(frame => frame.label), ["use woodCube", "use cube"]);
  });

  it("compiles templates and values re-exported through barrel modules", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { woodCube } from \"./barrel.rsgl\"",
          "use woodCube(acacia_planks)"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { woodCube } from \"./templates.rsgl\"")
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "import { woods } from \"./tables.rsgl\"",
          "template woodCube(id: ResourceId) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: woods.acacia }",
          "  }",
          "}",
          "export { woodCube }"
        ].join("\n"))
      },
      {
        fileName: tablesFile,
        module: parseRsgl([
          "namespace custom",
          "table woods {",
          "  acacia: block/acacia_planks",
          "}",
          "export { woods }"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/acacia_planks.json"
    ]);
    assert.deepStrictEqual(units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "custom:block/acacia_planks"
      }
    });
  });

  it("uses local and imported tables during compilation", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { woods as importedWoods, defaultParent } from \"./tables.rsgl\"",
          "table localWoods { spruce: texture_id(minecraft:block/spruce_planks) }",
          "model block acacia_planks {",
          "  parent defaultParent",
          "  textures { all: importedWoods.acacia }",
          "}",
          "model block spruce_planks {",
          "  parent defaultParent",
          "  textures { all: localWoods.spruce }",
          "}"
        ].join("\n"))
      },
      {
        fileName: tablesFile,
        module: parseRsgl([
          "namespace custom",
          "let defaultParent: ModelId = minecraft:block/cube_all",
          "table woods {",
          "  acacia: texture_id(block/acacia_planks)",
          "}"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const units = generatedResourceUnits(result);
    expectNoDiagnostics(result);
    assert.deepStrictEqual(units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/acacia_planks.json",
      "assets/minecraft/models/block/spruce_planks.json"
    ]);
    assert.deepStrictEqual(units.find(unit => unit.outputPath.endsWith("acacia_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "custom:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(units.find(unit => unit.outputPath.endsWith("spruce_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/spruce_planks"
      }
    });
  });
});
