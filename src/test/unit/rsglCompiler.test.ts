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

  it("lowers conventional blockstate sugar to blockstates", () => {
    const result = compileRsglModule(parseRsgl([
      "stairs acacia_stairs",
      "slab acacia_slab double minecraft:block/acacia_planks",
      "fence oak_fence",
      "wall cobblestone_wall",
      "pane glass_pane"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/blockstates/cobblestone_wall.json",
      "assets/minecraft/blockstates/glass_pane.json",
      "assets/minecraft/blockstates/oak_fence.json"
    ]);

    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    assert.ok(stairs);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
    const pane = result.units.find(unit => unit.outputPath.endsWith("glass_pane.json"));
    assert.ok(pane);
    assert.deepStrictEqual((pane.content as { multipart: unknown[] }).multipart[8], {
      when: { west: false },
      apply: { model: "minecraft:block/glass_pane_noside", y: 270 }
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

  it("lowers builtin use declarations to resources", () => {
    const result = compileRsglModule(parseRsgl([
      "use cubeAll(id: stone, texture: minecraft:block/stone)",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/stone.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/stone.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/stone"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/diamond.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/diamond"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/diamond.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("lowers wood family sugar to linked resources", () => {
    const result = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  texture minecraft:block/acacia_planks",
      "  generate [planks, slab, stairs, fence, fence_gate]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/acacia_fence.json",
      "assets/minecraft/blockstates/acacia_fence_gate.json",
      "assets/minecraft/blockstates/acacia_planks.json",
      "assets/minecraft/blockstates/acacia_slab.json",
      "assets/minecraft/blockstates/acacia_stairs.json",
      "assets/minecraft/items/acacia_fence.json",
      "assets/minecraft/items/acacia_fence_gate.json",
      "assets/minecraft/items/acacia_planks.json",
      "assets/minecraft/items/acacia_slab.json",
      "assets/minecraft/items/acacia_stairs.json",
      "assets/minecraft/models/block/acacia_fence_gate.json",
      "assets/minecraft/models/block/acacia_fence_gate_open.json",
      "assets/minecraft/models/block/acacia_fence_gate_wall.json",
      "assets/minecraft/models/block/acacia_fence_gate_wall_open.json",
      "assets/minecraft/models/block/acacia_fence_inventory.json",
      "assets/minecraft/models/block/acacia_fence_post.json",
      "assets/minecraft/models/block/acacia_fence_side.json",
      "assets/minecraft/models/block/acacia_planks.json",
      "assets/minecraft/models/block/acacia_slab.json",
      "assets/minecraft/models/block/acacia_slab_top.json",
      "assets/minecraft/models/block/acacia_stairs.json",
      "assets/minecraft/models/block/acacia_stairs_inner.json",
      "assets/minecraft/models/block/acacia_stairs_outer.json"
    ]);

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/acacia_planks"
      }
    });
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_planks.json"))?.content, {
      variants: {
        [defaultVariantKey]: {
          model: "minecraft:block/acacia_planks"
        }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_stairs_inner.json"))?.content, {
      parent: "minecraft:block/inner_stairs",
      textures: {
        bottom: "minecraft:block/acacia_planks",
        top: "minecraft:block/acacia_planks",
        side: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_fence.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/acacia_fence_inventory"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_fence_gate_wall_open.json"))?.content, {
      parent: "minecraft:block/template_fence_gate_wall_open",
      textures: {
        texture: "minecraft:block/acacia_planks"
      }
    });
    const fenceGateVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_fence_gate.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(fenceGateVariants).length, 16);
    assert.deepStrictEqual(fenceGateVariants["facing=east,in_wall=true,open=true"], {
      model: "minecraft:block/acacia_fence_gate_wall_open",
      uvlock: true,
      y: 270
    });
    assert.deepStrictEqual(fenceGateVariants["facing=south,in_wall=false,open=false"], {
      model: "minecraft:block/acacia_fence_gate",
      uvlock: true
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_fence_gate.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/acacia_fence_gate"
      }
    });
  });

  it("reports unsupported family members", () => {
    const result = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  texture minecraft:block/acacia_planks",
      "  generate [pane]",
      "}"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedFamilyMember"));
  });

  it("lowers door and trapdoor family members", () => {
    const result = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  generate [door, trapdoor]",
      "}"
    ].join("\n")));
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(outputPaths.length, 16);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_door.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_trapdoor.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_door.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_trapdoor.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_door.json"));

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_door_bottom_left.json"))?.content, {
      parent: "minecraft:block/door_bottom_left",
      textures: {
        bottom: "minecraft:block/acacia_door_bottom",
        top: "minecraft:block/acacia_door_top"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_trapdoor_open.json"))?.content, {
      parent: "minecraft:block/template_orientable_trapdoor_open",
      textures: {
        texture: "minecraft:block/acacia_trapdoor"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/acacia_door.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/acacia_door"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_door.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/acacia_door"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_trapdoor.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/acacia_trapdoor_bottom"
      }
    });

    const doorVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_door.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(doorVariants).length, 32);
    assert.deepStrictEqual(doorVariants["facing=east,half=lower,hinge=right,open=true"], {
      model: "minecraft:block/acacia_door_bottom_right_open",
      y: 270
    });
    assert.deepStrictEqual(doorVariants["facing=north,half=upper,hinge=left,open=true"], {
      model: "minecraft:block/acacia_door_top_left_open"
    });

    const trapdoorVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_trapdoor.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(trapdoorVariants).length, 16);
    assert.deepStrictEqual(trapdoorVariants["facing=east,half=top,open=true"], {
      model: "minecraft:block/acacia_trapdoor_open",
      x: 180,
      y: 270
    });
    assert.deepStrictEqual(trapdoorVariants["facing=north,half=bottom,open=false"], {
      model: "minecraft:block/acacia_trapdoor_bottom"
    });
  });

  it("lowers item range and select fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "table potionCases {",
      "  healing: minecraft:item/potion_healing",
      "  strong_healing: minecraft:item/potion_strong_healing",
      "}",
      "item compass {",
      "  use itemRangeFrames(",
      "    property: minecraft:compass,",
      "    target: spawn,",
      "    wobble: true,",
      "    frames: 0..2,",
      "    threshold: index / 3,",
      "    model: `minecraft:item/compass_${pad(index, 2)}`,",
      "    fallback: minecraft:item/compass_00",
      "  )",
      "}",
      "item potion {",
      "  use itemSelectCases(",
      "    property: minecraft:potion_contents,",
      "    component: minecraft:potion_contents,",
      "    cases: potionCases,",
      "    fallback: minecraft:item/potion",
      "  )",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/compass.json",
      "assets/minecraft/items/potion.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("compass.json"))?.content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:compass",
        target: "spawn",
        wobble: true,
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1 / 3, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } },
          { threshold: 2 / 3, model: { type: "minecraft:model", model: "minecraft:item/compass_02" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass_00"
        }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("potion.json"))?.content, {
      model: {
        type: "minecraft:select",
        property: "minecraft:potion_contents",
        component: "minecraft:potion_contents",
        cases: [
          { when: "healing", model: { type: "minecraft:model", model: "minecraft:item/potion_healing" } },
          { when: "strong_healing", model: { type: "minecraft:model", model: "minecraft:item/potion_strong_healing" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/potion"
        }
      }
    });
  });

  it("lowers generic JSON resource fragments", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "atlas minecraft:blocks {",
      "  use atlasDirectory(source: \"block\", prefix: \"block/\")",
      "  use atlasDirectory(source: \"item\", prefix: \"item/\")",
      "}",
      "particles explosion {",
      "  use particlesSeq(\"minecraft:particle/explosion_{00..02}\")",
      "}",
      "mcmeta \"assets/minecraft/textures/block/high_light.png\" {",
      "  use mcmetaAnimation(frametime: 5, interpolate: true)",
      "}",
      "equipment iron {",
      "  use equipmentLayers(texture: minecraft:iron, layers: [\"humanoid\", \"humanoid_leggings\"])",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/atlases/blocks.json",
      "assets/minecraft/equipment/iron.json",
      "assets/minecraft/particles/explosion.json",
      "assets/minecraft/textures/block/high_light.png.mcmeta"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "atlas")?.content, {
      sources: [
        { type: "minecraft:directory", source: "block", prefix: "block/" },
        { type: "minecraft:directory", source: "item", prefix: "item/" }
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "particles")?.content, {
      textures: [
        "minecraft:particle/explosion_00",
        "minecraft:particle/explosion_01",
        "minecraft:particle/explosion_02"
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "mcmeta")?.content, {
      animation: {
        frametime: 5,
        interpolate: true
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "equipment")?.content, {
      layers: {
        humanoid: [{ texture: "minecraft:iron" }],
        ["humanoid_leggings"]: [{ texture: "minecraft:iron" }]
      }
    });
    assert.ok(checkedResources.includes("texture:minecraft:particle/explosion_00"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid_leggings/iron"));
  });

  it("reports invalid generic JSON resource fragment arguments", () => {
    const result = compileRsglModule(parseRsgl([
      "particles explosion {",
      "  use particlesSeq({ bad: true })",
      "}",
      "equipment iron {",
      "  use equipmentLayers(texture: minecraft:iron, layers: 1)",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidParticlesSeqArgument"));
    assert.ok(codes.includes("rsgl.invalidEquipmentLayersArgument"));
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

  it("reports invalid template call arguments during compilation", () => {
    const result = compileRsglModule(parseRsgl([
      "template cube(id: ResourceId, texture: TextureId = id) {",
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
    ].join("\n")));
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
    assert.ok(codes.includes("rsgl.compileUnknownArgument"));
    assert.ok(codes.includes("rsgl.compileTooManyArguments"));
    assert.ok(codes.includes("rsgl.compileDuplicateArgument"));
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

  it("evaluates match expressions, builtin constants, comparisons, and path helpers", () => {
    const result = compileRsglModule(parseRsgl([
      "model block paths {",
      "  parent minecraft:block/cube_all",
      "  raw_json {",
      "    metadata: {",
      "      model_path: model_path(minecraft:block/stone),",
      "      texture_path: texture_path(block/stone),",
      "      compare: 3 >= 2",
      "    }",
      "  }",
      "}",
      "blockstate orient {",
      "  variants {",
      "    for dir in HORIZONTAL {",
      "      [facing=dir] -> {",
      "        model: match dir {",
      "          north | south -> minecraft:block/line",
      "          _ -> minecraft:block/turn",
      "        }",
      "        y: yaw(dir)",
      "        uvlock: dir != north",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/paths.json"))?.content, {
      parent: "minecraft:block/cube_all",
      metadata: {
        ["model_path"]: "assets/minecraft/models/block/stone.json",
        ["texture_path"]: "assets/minecraft/textures/block/stone.png",
        compare: true
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("blockstates/orient.json"))?.content, {
      variants: {
        ["facing=east"]: {
          model: "minecraft:block/turn",
          y: 90,
          uvlock: true
        },
        ["facing=north"]: {
          model: "minecraft:block/line",
          y: 0,
          uvlock: false
        },
        ["facing=south"]: {
          model: "minecraft:block/line",
          y: 180,
          uvlock: true
        },
        ["facing=west"]: {
          model: "minecraft:block/turn",
          y: 270,
          uvlock: true
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

  it("loads raw_json path fragments relative to RSGL source files", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const fragmentsDir = path.join(packDir, "fragments");
      const mainFile = path.join(packDir, "main.rsgl");
      const valuesFile = path.join(packDir, "values.rsgl");
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
      fs.writeFileSync(valuesFile, [
        "let itemFragment = raw_json(\"./fragments/item.json\")",
        "export { itemFragment }"
      ].join("\n"));
      fs.writeFileSync(mainFile, [
        "import { itemFragment } from \"./values.rsgl\"",
        "model block custom_panel {",
        "  raw_json(\"./fragments/model.json\")",
        "}",
        "item diamond {",
        "  raw_json itemFragment",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile);

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/items/diamond.json",
        "assets/minecraft/models/block/custom_panel.json"
      ]);
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("custom_panel.json"))?.content, {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/stone"
        },
        ambientocclusion: false
      });
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("diamond.json"))?.content, {
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

  it("reports raw_json path load and parse errors", () => {
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(path.join(root, "invalid.json"), "{");
      fs.writeFileSync(mainFile, [
        "model block missing {",
        "  raw_json(\"./missing.json\")",
        "}",
        "model block invalid {",
        "  raw_json(\"./invalid.json\")",
        "}"
      ].join("\n"));

      const result = compileRsglFile(mainFile);
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.rawJsonLoadFailed"));
      assert.ok(codes.includes("rsgl.rawJsonParseFailed"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("expands built-in blockstate fragments from use declarations", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate acacia_stairs {",
      "  use stairs(base: minecraft:block/acacia_stairs, inner: minecraft:block/acacia_stairs_inner, outer: minecraft:block/acacia_stairs_outer)",
      "}",
      "blockstate oak_fence {",
      "  multipart {",
      "    use fence(post: minecraft:block/oak_fence_post, side: minecraft:block/oak_fence_side)",
      "  }",
      "}",
      "blockstate acacia_fence_gate {",
      "  use fenceGate(",
      "    base: minecraft:block/acacia_fence_gate,",
      "    open: minecraft:block/acacia_fence_gate_open,",
      "    wall: minecraft:block/acacia_fence_gate_wall,",
      "    wallOpen: minecraft:block/acacia_fence_gate_wall_open",
      "  )",
      "}",
      "blockstate acacia_door {",
      "  use door(",
      "    bottomLeft: minecraft:block/acacia_door_bottom_left,",
      "    bottomLeftOpen: minecraft:block/acacia_door_bottom_left_open,",
      "    bottomRight: minecraft:block/acacia_door_bottom_right,",
      "    bottomRightOpen: minecraft:block/acacia_door_bottom_right_open,",
      "    topLeft: minecraft:block/acacia_door_top_left,",
      "    topLeftOpen: minecraft:block/acacia_door_top_left_open,",
      "    topRight: minecraft:block/acacia_door_top_right,",
      "    topRightOpen: minecraft:block/acacia_door_top_right_open",
      "  )",
      "}",
      "blockstate acacia_trapdoor {",
      "  use trapdoor(",
      "    bottom: minecraft:block/acacia_trapdoor_bottom,",
      "    top: minecraft:block/acacia_trapdoor_top,",
      "    open: minecraft:block/acacia_trapdoor_open",
      "  )",
      "}",
      "blockstate glass_pane {",
      "  use pane(",
      "    post: minecraft:block/glass_pane_post,",
      "    side: minecraft:block/glass_pane_side,",
      "    sideAlt: minecraft:block/glass_pane_side_alt,",
      "    noSide: minecraft:block/glass_pane_noside,",
      "    noSideAlt: minecraft:block/glass_pane_noside_alt",
      "  )",
      "}",
      "blockstate oak_leaves {",
      "  use randomVariants(",
      "    state: { persistent: false },",
      "    models: [",
      "      { model: minecraft:block/oak_leaves, weight: 2 },",
      "      { model: minecraft:block/oak_leaves_2 }",
      "    ]",
      "  )",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const stairs = result.units.find(unit => unit.outputPath.endsWith("acacia_stairs.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("oak_fence.json"));
    const fenceGate = result.units.find(unit => unit.outputPath.endsWith("acacia_fence_gate.json"));
    const door = result.units.find(unit => unit.outputPath.endsWith("acacia_door.json"));
    const trapdoor = result.units.find(unit => unit.outputPath.endsWith("acacia_trapdoor.json"));
    const pane = result.units.find(unit => unit.outputPath.endsWith("glass_pane.json"));
    const leaves = result.units.find(unit => unit.outputPath.endsWith("oak_leaves.json"));
    assert.ok(stairs);
    assert.ok(fence);
    assert.ok(fenceGate);
    assert.ok(door);
    assert.ok(trapdoor);
    assert.ok(pane);
    assert.ok(leaves);
    const variants = (stairs.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(variants).length, 40);
    assert.deepStrictEqual(variants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/acacia_stairs"
    });
    assert.deepStrictEqual(fence.content, {
      multipart: [
        { apply: { model: "minecraft:block/oak_fence_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/oak_fence_side" } },
        { when: { east: true }, apply: { model: "minecraft:block/oak_fence_side", y: 90, uvlock: true } },
        { when: { south: true }, apply: { model: "minecraft:block/oak_fence_side", y: 180, uvlock: true } },
        { when: { west: true }, apply: { model: "minecraft:block/oak_fence_side", y: 270, uvlock: true } }
      ]
    });
    const fenceGateVariants = (fenceGate.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(fenceGateVariants).length, 16);
    assert.deepStrictEqual(fenceGateVariants["facing=west,in_wall=false,open=true"], {
      model: "minecraft:block/acacia_fence_gate_open",
      uvlock: true,
      y: 90
    });
    const doorVariants = (door.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(doorVariants).length, 32);
    assert.deepStrictEqual(doorVariants["facing=south,half=upper,hinge=left,open=true"], {
      model: "minecraft:block/acacia_door_top_left_open",
      y: 180
    });
    const trapdoorVariants = (trapdoor.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(trapdoorVariants).length, 16);
    assert.deepStrictEqual(trapdoorVariants["facing=west,half=top,open=true"], {
      model: "minecraft:block/acacia_trapdoor_open",
      x: 180,
      y: 90
    });
    assert.deepStrictEqual(pane.content, {
      multipart: [
        { apply: { model: "minecraft:block/glass_pane_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/glass_pane_side" } },
        { when: { east: true }, apply: { model: "minecraft:block/glass_pane_side", y: 90 } },
        { when: { south: true }, apply: { model: "minecraft:block/glass_pane_side_alt" } },
        { when: { west: true }, apply: { model: "minecraft:block/glass_pane_side_alt", y: 90 } },
        { when: { north: false }, apply: { model: "minecraft:block/glass_pane_noside" } },
        { when: { east: false }, apply: { model: "minecraft:block/glass_pane_noside_alt" } },
        { when: { south: false }, apply: { model: "minecraft:block/glass_pane_noside_alt", y: 90 } },
        { when: { west: false }, apply: { model: "minecraft:block/glass_pane_noside", y: 270 } }
      ]
    });
    assert.deepStrictEqual(leaves.content, {
      variants: {
        ["persistent=false"]: [
          { model: "minecraft:block/oak_leaves", weight: 2 },
          { model: "minecraft:block/oak_leaves_2" }
        ]
      }
    });
  });

  it("lowers randomVariants inside explicit blockstate variants", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate stone {",
      "  variants {",
      "    {} -> randomVariants([",
      "      { model: minecraft:block/stone, weight: 3 },",
      "      { model: minecraft:block/stone_mirrored, y: 180, weight: 1 }",
      "    ])",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        [defaultVariantKey]: [
          { model: "minecraft:block/stone", weight: 3 },
          { model: "minecraft:block/stone_mirrored", y: 180, weight: 1 }
        ]
      }
    });
  });

  it("reports incompatible blockstate fragment use in section contexts", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate broken {",
      "  variants {",
      "    use fence(post: minecraft:block/fence_post, side: minecraft:block/fence_side)",
      "  }",
      "}"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.incompatibleBlockstateFragment"));
  });

  it("reports invalid randomVariants arguments", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate broken {",
      "  variants {",
      "    {} -> randomVariants({ bad: true })",
      "  }",
      "  use randomVariants(models: [{ bad: true }])",
      "}"
    ].join("\n")));
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidRandomVariantsArgument"));
    assert.ok(codes.includes("rsgl.invalidRandomVariantEntry"));
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

  it("fills pack metadata from RSGL target declarations", () => {
    const modern = compileRsglModule(parseRsgl([
      "target java mc \"1.21.11\"",
      "pack {",
      "  description \"Generated pack\"",
      "}"
    ].join("\n")));
    const legacy = compileRsglModule(parseRsgl([
      "target java mc \"1.21.8\"",
      "pack {",
      "  description \"Legacy pack\"",
      "}"
    ].join("\n")));
    const explicit = compileRsglModule(parseRsgl([
      "target java mc \"1.21.11\"",
      "pack {",
      "  description \"Explicit pack\"",
      "  pack_format 12",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(modern.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Generated pack",
        ["min_format"]: [75, 0],
        ["max_format"]: [75, 0]
      }
    });
    assert.deepStrictEqual(legacy.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Legacy pack",
        ["pack_format"]: 64
      }
    });
    assert.deepStrictEqual(explicit.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Explicit pack",
        ["pack_format"]: 12
      }
    });
  });

  it("lowers overlay blocks to prefixed resources and pack metadata", () => {
    const result = compileRsglModule(parseRsgl([
      "pack {",
      "  description \"Generated\"",
      "}",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block stone {",
      "    parent minecraft:block/cube_all",
      "    textures { all: minecraft:block/stone }",
      "  }",
      "  item stone {",
      "    model minecraft:block/stone",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "future/assets/minecraft/items/stone.json",
      "future/assets/minecraft/models/block/stone.json",
      "pack.mcmeta"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "pack.mcmeta")?.content, {
      pack: {
        description: "Generated"
      },
      overlays: {
        entries: [
          {
            directory: "future",
            ["min_format"]: [90, 0],
            ["max_format"]: [91, 0]
          }
        ]
      }
    });
    const model = result.units.find(unit => unit.outputPath.endsWith("models/block/stone.json"));
    assert.strictEqual(model?.sourceMap.generatedFile, "future/assets/minecraft/models/block/stone.json");
    assert.deepStrictEqual(model?.sourceMap.mappings.map(mapping => mapping.expansionStack.map(frame => frame.label)), [
      ["overlay future"]
    ]);
  });

  it("keeps overlay resources separate from base resource conflicts", () => {
    const result = compileRsglModule(parseRsgl([
      "model block stone { parent minecraft:block/cube_all }",
      "overlay \"future\" {",
      "  model block stone { parent minecraft:block/cube_all }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/stone.json",
      "future/assets/minecraft/models/block/stone.json",
      "pack.mcmeta"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "pack.mcmeta")?.content, {
      overlays: {
        entries: [
          {
            directory: "future"
          }
        ]
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
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/acacia_planks.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
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

  it("loads re-exported RSGL files from a filesystem entry", () => {
    const root = createTempDir();
    try {
      const packDir = path.join(root, "pack");
      const mainFile = path.join(packDir, "main.rsgl");
      const barrelFile = path.join(packDir, "barrel.rsgl");
      const templatesFile = path.join(packDir, "templates.rsgl");
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(templatesFile, [
        "template cube(id: ResourceId) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "  }",
        "}",
        "export { cube }"
      ].join("\n"));
      fs.writeFileSync(barrelFile, "export { cube } from \"./templates.rsgl\"");
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./barrel.rsgl\"",
        "use cube(stone)"
      ].join("\n"));

      const result = compileRsglFile(mainFile);

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
        "assets/minecraft/models/block/stone.json"
      ]);
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

  it("uses RSGL target declarations for version-gated validation", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format [74, 0]",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block rotated { parent minecraft:block/cube_all }",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
  });

  it("resolves RSGL Minecraft version targets to pack formats", () => {
    const modern = compileRsglModule(parseRsgl([
      "target java mc \"1.21.11\"",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}"
    ].join("\n")));
    const older = compileRsglModule(parseRsgl([
      "target java mc \"1.21.10\"",
      "blockstate rotated {",
      "  variants {",
      "    {} -> { model: minecraft:block/rotated, z: 90 }",
      "  }",
      "}"
    ].join("\n")));

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

  it("validates item model condition trees", () => {
    const result = compileRsglModule(parseRsgl([
      "item broken_compass {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:compass,",
      "      entries: [",
      "        { threshold: 1, model: { type: minecraft:model, model: minecraft:item/missing_high } },",
      "        { threshold: 0, model: { type: minecraft:model, model: minecraft:item/missing_low } }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item broken_select {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ model: { type: minecraft:model, model: minecraft:item/missing_case } }]",
      "    }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.unsortedItemRangeThresholds"));
    assert.ok(codes.includes("rsgl.itemModelMissingFallback"));
    assert.ok(codes.includes("rsgl.invalidItemSelectCase"));
  });

  it("validates generated model parent chains and texture variables", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "model block parent_model {",
      "  textures { base: minecraft:block/inherited_texture }",
      "}",
      "model block child_model {",
      "  parent minecraft:block/parent_model",
      "  textures { all: \"#base\" }",
      "}",
      "model block missing_variable {",
      "  textures { all: \"#missing\" }",
      "}",
      "model block texture_cycle {",
      "  textures { a: \"#b\", b: \"#a\" }",
      "}",
      "model block parent_a { parent minecraft:block/parent_b }",
      "model block parent_b { parent minecraft:block/parent_a }"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(checkedResources.includes("texture:minecraft:block/inherited_texture"));
    assert.ok(codes.includes("rsgl.unresolvedTextureVariable"));
    assert.ok(codes.includes("rsgl.textureVariableCycle"));
    assert.ok(codes.includes("rsgl.modelParentCycle"));
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
      "    { type: minecraft:directory, source: block/missing_directory },",
      "    { type: single, resource: minecraft:block/missing_single },",
      "    { type: minecraft:unstitch, resource: minecraft:block/missing_unstitch, regions: [{ sprite: block/slice, x: 0, y: 0, width: 16, height: 16 }] },",
      "    { type: filter, pattern: { namespace: \"[\", path: \"*\" } },",
      "    { type: paletted_permutations, textures: [minecraft:block/missing_palette], palette_key: minecraft:block/missing_palette_key, permutations: { red: minecraft:block/missing_permutation } }",
      "  ]",
      "}",
      "mcmeta \"assets/minecraft/textures/block/missing_anim.png\" {",
      "  animation { frametime 2 }",
      "}",
      "particles missing_particles {",
      "  textures [minecraft:particle/missing_particle]",
      "}",
      "equipment missing_equipment {",
      "  layers {",
      "    humanoid [",
      "      { texture: minecraft:missing_equipment }",
      "    ]",
      "  }",
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
    assert.ok(codes.includes("rsgl.textureDirectoryNotFound"));
    assert.ok(codes.includes("rsgl.invalidAtlasFilterPattern"));
    assert.ok(codes.includes("rsgl.invalidOverlayDirectory"));
    assert.ok(codes.includes("rsgl.invalidOverlayFormatRange"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient1"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/ambient2"));
    assert.strictEqual(checkedResources.includes("sound:custom:entity/example/event"), false);
    assert.ok(checkedResources.includes("textureDirectory:minecraft:block/missing_directory"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_single"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_unstitch"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_palette"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_palette_key"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_permutation"));
    assert.ok(checkedResources.includes("texture:minecraft:block/missing_anim"));
    assert.ok(checkedResources.includes("texture:minecraft:particle/missing_particle"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/missing_equipment"));
  });
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-"));
}
