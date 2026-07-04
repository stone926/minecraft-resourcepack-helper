import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileRsglFile, compileRsglModule, compileRsglProgram, createRsglWritePlan, emitRsglFiles, loadRsglSourceFilesFromFile, stableJsonStringify, writeRsglFiles } from "../../rsgl/compiler";
import { parseRsgl } from "../../rsgl/parser";

describe("RSGL compiler", () => {
  it("emits explicit model, item, and blockstate resources", () => {
    const result = compileRsglModule(parseRsgl([
      "namespace minecraft",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/stone }",
      "}",
      "item diamond {",
      "  model minecraft:item/diamond",
      "}",
      "blockstate stone {",
      "  variants {",
      "    {} -> { model: minecraft:block/stone }",
      "  }",
      "}"
    ].join("\n")), { fileName: "pack/rsgl/main.rsgl" });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/stone.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/stone.json"
    ]);

    const model = result.units.find(unit => unit.kind === "model");
    assert.ok(model);
    assert.strictEqual(stableJsonStringify(model.content, model.kind), [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const item = result.units.find(unit => unit.kind === "item");
    assert.deepStrictEqual(item?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("emits deterministic files with source maps and manifest", () => {
    const result = compileRsglModule(parseRsgl([
      "namespace minecraft",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/stone }",
      "}"
    ].join("\n")), { fileName: path.resolve("pack", "main.rsgl") });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
    assert.deepStrictEqual(files.map(file => file.outputPath), [
      "assets/minecraft/models/block/stone.json",
      "assets/minecraft/models/block/stone.json.rsgl.map",
      "rsgl.manifest.json"
    ]);

    assert.strictEqual(files[0].content, [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const sourceMap = JSON.parse(files[1].content) as {
      version?: number;
      generatedFile?: string;
      mappings?: Array<{ sourceFile?: string; reason?: string }>;
    };
    assert.strictEqual(sourceMap.version, 1);
    assert.strictEqual(sourceMap.generatedFile, "assets/minecraft/models/block/stone.json");
    assert.strictEqual(sourceMap.mappings?.[0]?.sourceFile, path.resolve("pack", "main.rsgl"));
    assert.strictEqual(sourceMap.mappings?.[0]?.reason, "direct");

    const manifest = JSON.parse(files[2].content) as {
      files?: Array<{ outputPath?: string; sourceMap?: string }>;
    };
    assert.deepStrictEqual(manifest.files, [{
      outputPath: "assets/minecraft/models/block/stone.json",
      kind: "model",
      id: "minecraft:block/stone",
      sourceMap: "assets/minecraft/models/block/stone.json.rsgl.map"
    }]);
  });

  it("plans and writes emitted files to a pack directory", () => {
    const root = createTempDir();
    try {
      const files = [
        {
          outputPath: "assets/minecraft/models/block/stone.json",
          content: "{\n  \"parent\": \"minecraft:block/cube_all\"\n}\n",
          kind: "resource" as const
        },
        {
          outputPath: "assets/minecraft/models/block/stone.json.rsgl.map",
          content: "{\n  \"version\": 1\n}\n",
          kind: "sourceMap" as const
        }
      ];

      const dryRun = createRsglWritePlan(files, root);
      assert.deepStrictEqual(dryRun.summary, { create: 2, update: 0, unchanged: 0 });
      assert.strictEqual(fs.existsSync(path.join(root, files[0].outputPath)), false);

      const written = writeRsglFiles(files, root);
      assert.deepStrictEqual(written.summary, { create: 2, update: 0, unchanged: 0 });
      assert.strictEqual(fs.readFileSync(path.join(root, files[0].outputPath), "utf8"), files[0].content);

      const unchanged = createRsglWritePlan(files, root);
      assert.deepStrictEqual(unchanged.summary, { create: 0, update: 0, unchanged: 2 });

      const updatedFiles = [{ ...files[0], content: `${files[0].content}\n` }];
      const update = createRsglWritePlan(updatedFiles, root, { includePreviousContent: true });
      assert.deepStrictEqual(update.summary, { create: 0, update: 1, unchanged: 0 });
      assert.strictEqual(update.entries[0].previousContent, files[0].content);
      assert.deepStrictEqual(update.entries[0].diff, { addedLines: 1, removedLines: 0 });

      assert.throws(
        () => createRsglWritePlan([{ ...files[0], outputPath: "../outside.json" }], root),
        /Unsafe RSGL output path/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lowers stairs, slab, fence, and wall sugar to blockstates", () => {
    const result = compileRsglModule(parseRsgl([
      "stairs acacia_stairs",
      "slab acacia_slab double minecraft:block/acacia_planks",
      "fence oak_fence",
      "wall cobblestone_wall"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/blockstates/cobblestone_wall.json",
      "assets/minecraft/blockstates/oak_fence.json"
    ]);

    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    assert.ok(stairs);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
  });

  it("lowers cube_all and items model batch sugar", () => {
    const result = compileRsglModule(parseRsgl([
      "cube_all [",
      "  stone",
      "  smooth_stone -> block/smooth_stone",
      "]",
      "items model [",
      "  diamond",
      "  acacia_stairs -> block/acacia_stairs",
      "]"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/acacia_stairs.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/smooth_stone.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("expands local templates with positional, named, and default arguments", () => {
    const result = compileRsglModule(parseRsgl([
      "template cube(id: ResourceId, texture: TextureId = id) {",
      "  model block id {",
      "    parent minecraft:block/cube_all",
      "    textures { all: texture }",
      "  }",
      "}",
      "use cube(stone, texture: minecraft:block/stone)"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
  });

  it("expands finite for loops over lists", () => {
    const result = compileRsglModule(parseRsgl([
      "for block in [minecraft:stone, minecraft:dirt] {",
      "  cube_all [block]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/dirt.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("expands product loops and template string interpolation", () => {
    const result = compileRsglModule(parseRsgl([
      "for state in product({ facing: [north, east], powered: [false, true] }) {",
      "  blockstate `lamp_${state.facing}_${state.powered}` {",
      "    variants {",
      "      {} -> { model: `minecraft:block/lamp_${state.facing}` }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/lamp_east_false.json",
      "assets/minecraft/blockstates/lamp_east_true.json",
      "assets/minecraft/blockstates/lamp_north_false.json",
      "assets/minecraft/blockstates/lamp_north_true.json"
    ]);
    const emptyVariantKey = "";
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("lamp_east_true.json"))?.content, {
      variants: {
        [emptyVariantKey]: {
          model: "minecraft:block/lamp_east"
        }
      }
    });
  });

  it("expands for and if statements inside resource bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "model block layered {",
      "  parent minecraft:block/cube_all",
      "  if true {",
      "    ambientocclusion false",
      "  } else {",
      "    ambientocclusion true",
      "  }",
      "  textures {",
      "    for layer in [{ key: \"layer0\", tex: minecraft:block/stone }, { key: \"layer1\", tex: minecraft:block/dirt }] {",
      "      raw_json { [layer.key]: layer.tex }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      ambientocclusion: false,
      textures: {
        layer0: "minecraft:block/stone",
        layer1: "minecraft:block/dirt"
      }
    });
  });

  it("expands for statements inside blockstate variants", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    for state in product({ facing: [north, east], powered: [false, true] }) {",
      "      [facing=state.facing powered=state.powered] -> { model: `minecraft:block/lamp_${state.facing}` }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const expectedVariants = {
      ["facing=east,powered=false"]: {
        model: "minecraft:block/lamp_east"
      },
      ["facing=east,powered=true"]: {
        model: "minecraft:block/lamp_east"
      },
      ["facing=north,powered=false"]: {
        model: "minecraft:block/lamp_north"
      },
      ["facing=north,powered=true"]: {
        model: "minecraft:block/lamp_north"
      }
    };
    assert.deepStrictEqual(result.units[0].content, {
      variants: expectedVariants
    });
  });

  it("expands for and if statements inside blockstate multipart sections", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate oak_fence {",
      "  multipart {",
      "    apply { model: minecraft:block/oak_fence_post }",
      "    for side in [north, east] {",
      "      when { [side]: true } apply { model: `minecraft:block/oak_fence_side_${side}` }",
      "    }",
      "    if false {",
      "      apply { model: minecraft:block/unused }",
      "    } else {",
      "      when { west: true } apply { model: minecraft:block/oak_fence_side_west }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/oak_fence_post"
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_north"
          },
          when: {
            north: true
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_east"
          },
          when: {
            east: true
          }
        },
        {
          apply: {
            model: "minecraft:block/oak_fence_side_west"
          },
          when: {
            west: true
          }
        }
      ]
    });
  });

  it("emits pack, lang, sounds, and mcmeta resources", () => {
    const result = compileRsglModule(parseRsgl([
      "pack {",
      "  description \"Generated pack\"",
      "  pack_format 88",
      "}",
      "lang en_us {",
      "  \"block.minecraft.stone\" \"Stone\"",
      "}",
      "lang minecraft:en_us {",
      "  \"item.minecraft.stick\" \"Stick\"",
      "}",
      "sounds minecraft {",
      "  \"block.example.break\" { sounds: [\"block/example_break\"] }",
      "}",
      "mcmeta \"assets/minecraft/textures/block/glow.png\" {",
      "  animation { frametime 5 }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/lang/en_us.json",
      "assets/minecraft/sounds.json",
      "assets/minecraft/textures/block/glow.png.mcmeta",
      "pack.mcmeta"
    ]);

    const pack = result.units.find(unit => unit.kind === "pack");
    assert.deepStrictEqual(pack?.content, {
      pack: {
        description: "Generated pack",
        ["pack_format"]: 88
      }
    });

    const expectedLang = {
      ["block.minecraft.stone"]: "Stone",
      ["item.minecraft.stick"]: "Stick"
    };
    const lang = result.units.find(unit => unit.kind === "lang");
    assert.deepStrictEqual(lang?.content, expectedLang);
    assert.strictEqual(lang?.sourceMap.mappings.length, 2);

    const expectedSounds = {
      ["block.example.break"]: {
        sounds: ["block/example_break"]
      }
    };
    const sounds = result.units.find(unit => unit.kind === "sounds");
    assert.deepStrictEqual(sounds?.content, expectedSounds);

    const mcmeta = result.units.find(unit => unit.kind === "mcmeta");
    assert.deepStrictEqual(mcmeta?.content, {
      animation: {
        frametime: 5
      }
    });
  });

  it("reports non-finite loops inside resource bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "model block bad {",
      "  for item in { key: \"value\" } {",
      "    parent minecraft:block/cube_all",
      "  }",
      "}"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.compileNonFiniteLoop"));
  });

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
          "template cube(id: ResourceId, texture: TextureId = id) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: texture }",
          "  }",
          "}"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
    const mapping = result.units[0].sourceMap.mappings[0];
    assert.strictEqual(mapping.sourceFile, templatesFile);
    assert.strictEqual(mapping.reason, "template");
    assert.deepStrictEqual(mapping.expansionStack.map(frame => frame.label), ["use cubeModel"]);
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
          "let parentModel = block/cube_all",
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
          "  acacia: block/acacia_planks",
          "}"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/custom/models/block/oak_planks.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "custom:block/cube_all",
      textures: {
        all: "textures:block/acacia_planks"
      }
    });
    const mapping = result.units[0].sourceMap.mappings[0];
    assert.strictEqual(mapping.sourceFile, templatesFile);
    assert.deepStrictEqual(mapping.expansionStack.map(frame => frame.label), ["use woodCube", "use cube"]);
  });

  it("uses local and imported tables during compilation", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { woods as importedWoods, defaultParent } from \"./tables.rsgl\"",
          "table localWoods { spruce: minecraft:block/spruce_planks }",
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
          "let defaultParent = minecraft:block/cube_all",
          "table woods {",
          "  acacia: block/acacia_planks",
          "}"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/acacia_planks.json",
      "assets/minecraft/models/block/spruce_planks.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("acacia_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "custom:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("spruce_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/spruce_planks"
      }
    });
  });

  it("loads imported RSGL files from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const mainFile = path.join(packDir, "main.rsgl");
      const templatesFile = path.join(packDir, "templates.rsgl");
      const tablesFile = path.join(packDir, "tables.rsgl");
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(tablesFile, [
        "namespace custom",
        "let defaultParent = minecraft:block/cube_all",
        "table woods {",
        "  acacia: block/acacia_planks",
        "}"
      ].join("\n"));
      fs.writeFileSync(templatesFile, [
        "template cube(id: ResourceId, texture: TextureId = id) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}"
      ].join("\n"));
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "import { woods, defaultParent } from \"./tables.rsgl\"",
        "use cube(acacia_planks, texture: woods.acacia)",
        "model block spruce_planks {",
        "  parent defaultParent",
        "  textures { all: minecraft:block/spruce_planks }",
        "}"
      ].join("\n"));

      const loadedFiles = loadRsglSourceFilesFromFile(mainFile);
      assert.deepStrictEqual(loadedFiles.map(file => file.fileName).sort(), [
        mainFile,
        tablesFile,
        templatesFile
      ].map(fileName => path.normalize(path.resolve(fileName))).sort());

      const result = compileRsglFile(mainFile);

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/models/block/acacia_planks.json",
        "assets/minecraft/models/block/spruce_planks.json"
      ]);
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("acacia_planks.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "custom:block/acacia_planks"
        }
      });
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("spruce_planks.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/spruce_planks"
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing and cyclic imports from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      const cycleFile = path.join(root, "cycle.rsgl");
      fs.writeFileSync(mainFile, [
        "import \"./missing.rsgl\"",
        "import \"./cycle.rsgl\"",
        "model block stone { parent minecraft:block/cube_all }"
      ].join("\n"));
      fs.writeFileSync(cycleFile, "import \"./main.rsgl\"\n");

      const result = compileRsglFile(mainFile);
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.missingImport"));
      assert.ok(codes.includes("rsgl.importCycle"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports output conflicts across compiled RSGL files", () => {
    const firstFile = path.resolve("pack", "first.rsgl");
    const secondFile = path.resolve("pack", "second.rsgl");
    const result = compileRsglProgram([
      {
        fileName: firstFile,
        module: parseRsgl("cube_all [stone]")
      },
      {
        fileName: secondFile,
        module: parseRsgl("model block stone { parent minecraft:block/cube_all }")
      }
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
  });

  it("reports output path conflicts", () => {
    const result = compileRsglModule(parseRsgl([
      "cube_all [stone]",
      "model block stone { parent minecraft:block/cube_all }"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.outputConflict"));
  });

  it("validates generated resource references and target-gated fields", () => {
    const result = compileRsglModule(parseRsgl([
      "model block stone {",
      "  parent minecraft:block/missing_parent",
      "  textures { all: minecraft:block/missing_texture }",
      "}",
      "blockstate stone {",
      "  variants {",
      "    {} -> { model: minecraft:block/missing_model, z: 90, weight: 0 }",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 74 },
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
    assert.ok(codes.includes("rsgl.invalidRandomWeight"));
  });

  it("validates sound, atlas, mcmeta, and overlay resources", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "sounds custom {",
      "  \"entity.example.ambient\" {",
      "    sounds: [",
      "      \"entity/example/ambient1\",",
      "      { name: \"entity/example/ambient2\" },",
      "      { name: \"entity/example/event\", type: event }",
      "    ]",
      "  }",
      "}",
      "atlas minecraft:blocks {",
      "  sources [",
      "    { type: single, resource: minecraft:block/missing_single },",
      "    { type: paletted_permutations, textures: [minecraft:block/missing_palette], permutations: { red: minecraft:block/missing_permutation } }",
      "  ]",
      "}",
      "mcmeta \"assets/minecraft/textures/block/missing_anim.png\" {",
      "  animation { frametime 2 }",
      "}",
      "pack {",
      "  pack { description \"Generated\" }",
      "  overlays {",
      "    entries [",
      "      { directory: \"Bad/Overlay\", min_format: [90, 0], max_format: [89, 0] },",
      "      { directory: \"future\", min_format: [90, 0], max_format: [91, 0] }",
      "    ]",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 88 },
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.soundNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.invalidOverlayDirectory"));
    assert.ok(codes.includes("rsgl.invalidOverlayFormatRange"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient1"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient2"));
    assert.strictEqual(checkedResources.includes("sound:custom:entity/example/event"), false);
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_single"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_palette"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_permutation"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_anim"));
  });
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-"));
}
