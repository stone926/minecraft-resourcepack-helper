import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceResourceCache } from "../../services/workspaceResourceCache";
import { compileRsglFile, compileRsglModule, compileRsglProgram, createRsglWritePlan, emitRsglFiles, inferBlockstateSchemaFromContent, loadRsglSourceFilesFromFile, stableJsonStringify, validateResourceUnits, type JsonValue, type ResourceUnit, type RsglEmittedFile, writeRsglFiles } from "../../rsgl/compiler";
import { parseRsgl } from "../../rsgl/parser";
import { createRsglWorkspaceValidationOptions } from "../../rsgl/workspaceValidation";

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
    assert.strictEqual(stableJsonStringify(model.content as JsonValue, model.kind), [
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

  it("preserves empty list expressions in resource raw json", () => {
    const result = compileRsglModule(parseRsgl([
      "atlas blocks {",
      "  raw_json { sources: [] }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "atlas")?.content, {
      sources: []
    });
  });

  it("records nested source map entries for raw json fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "item tinted {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [{ type: minecraft:constant, value: [1, 0.5, 0] }]",
      "    }",
      "  }",
      "}"
    ].join("\n")), { fileName: path.resolve("pack", "main.rsgl") });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const paths = result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath);
    assert.ok(paths.includes("/model/type"));
    assert.ok(paths.includes("/model/tints/0/type"));
    assert.ok(paths.includes("/model/tints/0/value/1"));
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

    assert.strictEqual(emittedContent(files[0]), [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const sourceMap = JSON.parse(emittedContent(files[1])) as {
      version?: number;
      generatedFile?: string;
      mappings?: Array<{ generatedPath?: string; sourceFile?: string; reason?: string }>;
    };
    assert.strictEqual(sourceMap.version, 1);
    assert.strictEqual(sourceMap.generatedFile, "assets/minecraft/models/block/stone.json");
    assert.deepStrictEqual(sourceMap.mappings?.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/all"
    ]);
    assert.strictEqual(sourceMap.mappings?.[0]?.sourceFile, path.resolve("pack", "main.rsgl"));
    assert.strictEqual(sourceMap.mappings?.[0]?.reason, "direct");

    const manifest = JSON.parse(emittedContent(files[2])) as {
      files?: Array<{ outputPath?: string; sourceMap?: string }>;
    };
    assert.deepStrictEqual(manifest.files, [{
      outputPath: "assets/minecraft/models/block/stone.json",
      kind: "model",
      id: "minecraft:block/stone",
      sourceMap: "assets/minecraft/models/block/stone.json.rsgl.map"
    }]);
  });

  it("emits text resources without JSON stringification", () => {
    const result = compileRsglModule(parseRsgl([
      "namespace minecraft",
      "let player = \"PLAYERNAME\"",
      "text texts/end {",
      "  content `Good luck, ${player}\\n`",
      "}",
      "text \"assets/minecraft/texts/splashes.txt\" {",
      "  content \"Generated splash\"",
      "}"
    ].join("\n")), { fileName: path.resolve("pack", "main.rsgl") });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/texts/end.txt",
      "assets/minecraft/texts/splashes.txt"
    ]);

    const endText = result.units.find(unit => unit.outputPath.endsWith("end.txt"));
    assert.deepStrictEqual(endText?.content, {
      kind: "text",
      text: "Good luck, PLAYERNAME\\n"
    });
    const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
    assert.strictEqual(emittedContent(files.find(file => file.outputPath.endsWith("end.txt"))), "Good luck, PLAYERNAME\\n");

    const sourceMap = JSON.parse(emittedContent(files.find(file => file.outputPath.endsWith("end.txt.rsgl.map")))) as {
      mappings?: Array<{ generatedPath?: string; sourceFile?: string }>;
    };
    assert.deepStrictEqual(sourceMap.mappings?.map(mapping => mapping.generatedPath), ["", ""]);
    assert.strictEqual(sourceMap.mappings?.[0]?.sourceFile, path.resolve("pack", "main.rsgl"));

    const manifest = JSON.parse(emittedContent(files.find(file => file.outputPath === "rsgl.manifest.json"))) as {
      files?: Array<{ outputPath?: string; kind?: string; id?: string }>;
    };
    assert.ok(manifest.files?.some(file =>
      file.outputPath === "assets/minecraft/texts/end.txt" &&
      file.kind === "text" &&
      file.id === "minecraft:texts/end"
    ));
  });

  it("reports invalid text resource bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "text \"../outside.txt\" { content \"bad\" }",
      "text valid {",
      "  content [1, 2]",
      "  extra true",
      "}"
    ].join("\n")));
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.compileInvalidTextTarget"));
    assert.ok(codes.includes("rsgl.invalidTextContent"));
    assert.ok(codes.includes("rsgl.invalidTextResourceField"));
  });

  it("keeps copy-shaped JSON content on the JSON emit path", () => {
    const result = compileRsglModule(parseRsgl([
      "model block copy_shape {",
      "  kind \"copy\"",
      "  sourcePath \"textures/source.png\"",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(emittedContent(emitRsglFiles(result.units)[0]), [
      "{",
      "  \"kind\": \"copy\",",
      "  \"sourcePath\": \"textures/source.png\"",
      "}",
      ""
    ].join("\n"));
  });

  it("emits and writes binary copy resources", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "source.png");
      const entryFile = path.join(root, "main.rsgl");
      const outputRoot = path.join(root, "out");
      const sourceBytes = Buffer.from([0, 1, 2, 255]);
      fs.writeFileSync(sourceFile, sourceBytes);

      const result = compileRsglModule(parseRsgl([
        "namespace minecraft",
        "copy \"pack.png\" {",
        "  from \"source.png\"",
        "}",
        "copy minecraft:textures/block/copied.png {",
        "  from \"source.png\"",
        "}"
      ].join("\n")), { fileName: entryFile });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/textures/block/copied.png",
        "pack.png"
      ]);
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "pack.png")?.content, {
        kind: "copy",
        sourcePath: sourceFile
      });

      const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
      const copyFile = files.find(file => file.outputPath === "pack.png");
      assert.ok(copyFile && "copyFrom" in copyFile);
      assert.strictEqual(copyFile.copyFrom, sourceFile);

      const written = writeRsglFiles(files, outputRoot);
      assert.deepStrictEqual(written.summary, { create: 5, update: 0, unchanged: 0 });
      assert.deepStrictEqual(fs.readFileSync(path.join(outputRoot, "pack.png")), sourceBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(outputRoot, "assets", "minecraft", "textures", "block", "copied.png")), sourceBytes);

      const unchanged = createRsglWritePlan(files, outputRoot);
      assert.deepStrictEqual(unchanged.summary, { create: 0, update: 0, unchanged: 5 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports invalid binary copy resources", () => {
    const root = createTempDir();
    try {
      const result = compileRsglModule(parseRsgl([
        "copy \"bad:name\" { from \"missing.bin\" }",
        "copy \"pack.png\" {",
        "  from [1]",
        "  extra true",
        "}",
        "copy \"assets/minecraft/textures/block/missing.png\" {",
        "  from \"missing.bin\"",
        "}"
      ].join("\n")), { fileName: path.join(root, "main.rsgl") });
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.compileInvalidCopyTarget"));
      assert.ok(codes.includes("rsgl.invalidCopySource"));
      assert.ok(codes.includes("rsgl.invalidCopyResourceField"));
      assert.ok(codes.includes("rsgl.copySourceNotFound"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("lowers stairs sugar custom model patterns", () => {
    const result = compileRsglModule(parseRsgl("stairs acacia_stairs models \"minecraft:block/stair/{id}\""));
    const variants = (result.units[0].content as { variants: Record<string, Record<string, unknown>> }).variants;

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(variants["facing=east,half=bottom,shape=straight"].model, "minecraft:block/stair/acacia_stairs");
    assert.strictEqual(variants["facing=east,half=bottom,shape=inner_left"].model, "minecraft:block/stair/acacia_stairs_inner");
    assert.strictEqual(variants["facing=east,half=bottom,shape=outer_left"].model, "minecraft:block/stair/acacia_stairs_outer");
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

  it("lowers blockFamily builtin use to linked resources", () => {
    const result = compileRsglModule(parseRsgl([
      "use blockFamily(",
      "  base: minecraft:acacia,",
      "  texture: minecraft:block/acacia_planks,",
      "  variants: [cube, slab, stairs],",
      "  itemModels: true",
      ")"
    ].join("\n")));
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(outputPaths.length, 12);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_planks.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_slab.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_stairs.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_planks.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/acacia_stairs_inner.json"));
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_planks.json"))?.content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_planks.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units[0].sourceMap.mappings[0].expansionStack.map(frame => frame.label), [
      "blockFamily acacia"
    ]);
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
      "  generate [recipe]",
      "}"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedFamilyMember"));
  });

  it("lowers wall and pane family members", () => {
    const result = compileRsglModule(parseRsgl([
      "block_family glass {",
      "  texture minecraft:block/glass",
      "  generate [wall, pane]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const outputPaths = result.units.map(unit => unit.outputPath).sort();
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/glass_wall.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/glass_pane.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/glass_wall.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/glass_pane.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/glass_wall_inventory.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/block/glass_pane_noside.json"));

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/glass_wall_side_tall.json"))?.content, {
      parent: "minecraft:block/template_wall_side_tall",
      textures: {
        wall: "minecraft:block/glass"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/glass_pane_side_alt.json"))?.content, {
      parent: "minecraft:block/template_glass_pane_side_alt",
      textures: {
        pane: "minecraft:block/glass",
        edge: "minecraft:block/glass"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/glass_wall.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:block/glass_wall_inventory"
      }
    });
    const paneBlockstate = result.units.find(unit => unit.outputPath.endsWith("blockstates/glass_pane.json"));
    assert.deepStrictEqual((paneBlockstate?.content as { multipart: unknown[] }).multipart[8], {
      when: { west: false },
      apply: { model: "minecraft:block/glass_pane_noside", y: 270 }
    });
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

  it("lowers button, pressure plate, and sign family members", () => {
    const result = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  generate [button, pressure_plate, sign]",
      "}"
    ].join("\n")));
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(outputPaths.length, 18);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_button.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_pressure_plate.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_wall_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_button.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_pressure_plate.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_sign.json"));

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_button_pressed.json"))?.content, {
      parent: "minecraft:block/button_pressed",
      textures: {
        texture: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_pressure_plate_down.json"))?.content, {
      parent: "minecraft:block/pressure_plate_down",
      textures: {
        texture: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_sign_rot_2.json"))?.content, {
      parent: "minecraft:block/template_sign_rot_2",
      textures: {
        all: "minecraft:block/acacia_sign",
        particle: "minecraft:block/acacia_planks"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_wall_sign.json"))?.content, {
      parent: "minecraft:block/template_wall_sign",
      textures: {
        all: "minecraft:block/acacia_sign",
        particle: "minecraft:block/acacia_planks"
      }
    });

    const buttonVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_button.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(buttonVariants).length, 24);
    assert.deepStrictEqual(buttonVariants["face=wall,facing=west,powered=true"], {
      model: "minecraft:block/acacia_button_pressed",
      x: 90,
      uvlock: true,
      y: 270
    });

    const poweredFalse = "powered=false";
    const poweredTrue = "powered=true";
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_pressure_plate.json"))?.content, {
      variants: {
        [poweredFalse]: { model: "minecraft:block/acacia_pressure_plate" },
        [poweredTrue]: { model: "minecraft:block/acacia_pressure_plate_down" }
      }
    });

    const signVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_sign.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(signVariants).length, 16);
    assert.deepStrictEqual(signVariants["rotation=12"], {
      model: "minecraft:block/acacia_sign_rot_0",
      y: 270
    });
    const wallSignVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_wall_sign.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.deepStrictEqual(wallSignVariants["facing=east"], {
      model: "minecraft:block/acacia_wall_sign",
      y: 270
    });

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_sign.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/acacia_sign"
      }
    });
  });

  it("lowers hanging sign and boat family members", () => {
    const result = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  generate [hanging_sign, boat, chest_boat]",
      "}"
    ].join("\n")));
    const outputPaths = result.units.map(unit => unit.outputPath).sort();

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(outputPaths.length, 17);
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/blockstates/acacia_wall_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/items/acacia_chest_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_hanging_sign.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_boat.json"));
    assert.ok(outputPaths.includes("assets/minecraft/models/item/acacia_chest_boat.json"));

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_hanging_sign_attached_rot_0.json"))?.content, {
      parent: "minecraft:block/template_attached_hanging_sign_rot_0",
      textures: {
        all: "minecraft:block/acacia_hanging_sign",
        particle: "minecraft:block/stripped_acacia_log"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/block/acacia_wall_hanging_sign.json"))?.content, {
      parent: "minecraft:block/template_wall_hanging_sign",
      textures: {
        all: "minecraft:block/acacia_hanging_sign",
        particle: "minecraft:block/stripped_acacia_log"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/acacia_chest_boat.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/acacia_chest_boat"
      }
    });

    const hangingSignVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_hanging_sign.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(hangingSignVariants).length, 32);
    assert.deepStrictEqual(hangingSignVariants["attached=true,rotation=12"], {
      model: "minecraft:block/acacia_hanging_sign_attached_rot_0",
      y: 270
    });
    assert.deepStrictEqual(hangingSignVariants["attached=false,rotation=3"], {
      model: "minecraft:block/acacia_hanging_sign_rot_3"
    });

    const wallHangingSignVariants = (result.units.find(unit => unit.outputPath.endsWith("blockstates/acacia_wall_hanging_sign.json"))?.content as { variants: Record<string, unknown> }).variants;
    assert.deepStrictEqual(wallHangingSignVariants["facing=north"], {
      model: "minecraft:block/acacia_wall_hanging_sign",
      y: 180
    });

    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_boat.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/acacia_boat"
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("items/acacia_chest_boat.json"))?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/acacia_chest_boat"
      }
    });
  });

  it("uses hanging sign particle defaults and overrides", () => {
    const bamboo = compileRsglModule(parseRsgl([
      "wood_family bamboo {",
      "  generate [hanging_sign]",
      "}"
    ].join("\n")));
    const custom = compileRsglModule(parseRsgl([
      "wood_family acacia {",
      "  hanging_sign_particle custom:block/hanging_post",
      "  generate [hanging_sign]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(bamboo.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(custom.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(bamboo.units.find(unit => unit.outputPath.endsWith("models/block/bamboo_hanging_sign_rot_0.json"))?.content, {
      parent: "minecraft:block/template_hanging_sign_rot_0",
      textures: {
        all: "minecraft:block/bamboo_hanging_sign",
        particle: "minecraft:block/bamboo_planks"
      }
    });
    assert.deepStrictEqual(custom.units.find(unit => unit.outputPath.endsWith("models/block/acacia_hanging_sign_rot_0.json"))?.content, {
      parent: "minecraft:block/template_hanging_sign_rot_0",
      textures: {
        all: "minecraft:block/acacia_hanging_sign",
        particle: "custom:block/hanging_post"
      }
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

  it("lowers item range and select statements", () => {
    const result = compileRsglModule(parseRsgl([
      "item compass {",
      "  range property minecraft:compass target spawn wobble true {",
      "    frames 0..2 model `minecraft:item/compass_${pad(index, 2)}`",
      "    fallback minecraft:item/compass_00",
      "  }",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents component minecraft:potion_contents {",
      "    case \"minecraft:healing\" -> minecraft:item/potion_healing",
      "    case \"minecraft:strong_healing\" -> minecraft:item/potion_strong_healing",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("compass.json"))?.content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:compass",
        target: "spawn",
        wobble: true,
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } },
          { threshold: 2, model: { type: "minecraft:model", model: "minecraft:item/compass_02" } }
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
          { when: "minecraft:healing", model: { type: "minecraft:model", model: "minecraft:item/potion_healing" } },
          { when: "minecraft:strong_healing", model: { type: "minecraft:model", model: "minecraft:item/potion_strong_healing" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/potion"
        }
      }
    });
  });

  it("lowers item statements inside user fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "fragment compassModel(frames: Json = 0..1) {",
      "  range property minecraft:compass target spawn {",
      "    frames frames model `minecraft:item/compass_${pad(index, 2)}`",
      "    fallback minecraft:item/compass_00",
      "  }",
      "}",
      "item compass {",
      "  use compassModel()",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:compass",
        target: "spawn",
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_00" } },
          { threshold: 1, model: { type: "minecraft:model", model: "minecraft:item/compass_01" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass_00"
        }
      }
    });
  });

  it("lowers item condition and composite statements", () => {
    const result = compileRsglModule(parseRsgl([
      "item bow {",
      "  condition property minecraft:using_item {",
      "    on_true minecraft:item/bow_pulling_0",
      "    on_false minecraft:item/bow",
      "  }",
      "}",
      "item layered {",
      "  composite {",
      "    model minecraft:item/base",
      "    model { model: minecraft:item/overlay, weight: 2 }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("bow.json"))?.content, {
      model: {
        type: "minecraft:condition",
        property: "minecraft:using_item",
        ["on_true"]: { type: "minecraft:model", model: "minecraft:item/bow_pulling_0" },
        ["on_false"]: { type: "minecraft:model", model: "minecraft:item/bow" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("layered.json"))?.content, {
      model: {
        type: "minecraft:composite",
        models: [
          { type: "minecraft:model", model: "minecraft:item/base" },
          { type: "minecraft:model", model: "minecraft:item/overlay", weight: 2 }
        ]
      }
    });
  });

  it("lowers item special, empty, and selected item statements", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "item shield {",
      "  special base minecraft:item/shield model { type: minecraft:shield }",
      "}",
      "item chest {",
      "  special base minecraft:item/chest model { type: minecraft:chest, texture: \"christmas\" }",
      "}",
      "item hidden {",
      "  empty",
      "}",
      "item bundle {",
      "  selected_item",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("shield.json"))?.content, {
      model: {
        type: "minecraft:special",
        base: "minecraft:item/shield",
        model: { type: "minecraft:shield" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("chest.json"))?.content, {
      model: {
        type: "minecraft:special",
        base: "minecraft:item/chest",
        model: { type: "minecraft:chest", texture: "christmas" }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("hidden.json"))?.content, {
      model: { type: "minecraft:empty" }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("bundle.json"))?.content, {
      model: { type: "minecraft:bundle/selected_item" }
    });
    assert.ok(checkedResources.includes("model:minecraft:item/shield"));
    assert.ok(checkedResources.includes("model:minecraft:item/chest"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/chest/christmas"));
  });

  it("lowers item mappings to legacy item model files for older targets", () => {
    const result = compileRsglModule(parseRsgl([
      "target java mc \"1.21.8\"",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)",
      "items model [",
      "  acacia_stairs -> block/acacia_stairs",
      "]",
      "item custom_tool {",
      "  model minecraft:item/diamond",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/item/acacia_stairs.json",
      "assets/minecraft/models/item/custom_tool.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/acacia_stairs.json"))?.content, {
      parent: "minecraft:block/acacia_stairs"
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/custom_tool.json"))?.content, {
      parent: "minecraft:item/diamond"
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("models/item/diamond.json"))?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/diamond"
      }
    });
  });

  it("lowers custom model data item dispatch to legacy overrides", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item wand {",
      "  range property minecraft:custom_model_data {",
      "    frames [1, 2] model `minecraft:item/wand_${index}`",
      "    fallback minecraft:item/wand",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/item/wand.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/wand"
      },
      overrides: [
        {
          predicate: { ["custom_model_data"]: 1 },
          model: "minecraft:item/wand_0"
        },
        {
          predicate: { ["custom_model_data"]: 2 },
          model: "minecraft:item/wand_1"
        }
      ]
    });
    assert.strictEqual(result.units[0].kind, "model");
  });

  it("lowers legacy custom model data select cases", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item numbered {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:custom_model_data,",
      "    cases: [",
      "      { when: [1, 2], model: { type: minecraft:model, model: minecraft:item/numbered_one } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/numbered }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/numbered"
      },
      overrides: [
        {
          predicate: { ["custom_model_data"]: 1 },
          model: "minecraft:item/numbered_one"
        },
        {
          predicate: { ["custom_model_data"]: 2 },
          model: "minecraft:item/numbered_one"
        }
      ]
    });
  });

  it("flattens nested legacy item model predicates", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item bow {",
      "  model: {",
      "    type: minecraft:condition,",
      "    property: minecraft:using_item,",
      "    on_false: { type: minecraft:model, model: minecraft:item/bow },",
      "    on_true: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:custom_model_data,",
      "      fallback: { type: minecraft:model, model: minecraft:item/bow_pulling_0 },",
      "      entries: [",
      "        { threshold: 1, model: { type: minecraft:model, model: minecraft:item/bow_pulling_special } }",
      "      ]",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/bow"
      },
      overrides: [
        {
          predicate: { pulling: 1 },
          model: "minecraft:item/bow_pulling_0"
        },
        {
          predicate: {
            pulling: 1,
            ["custom_model_data"]: 1
          },
          model: "minecraft:item/bow_pulling_special"
        }
      ]
    });
  });

  it("maps additional modern item properties to legacy predicates", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item crossbow {",
      "  range property minecraft:crossbow/pull {",
      "    frames [0.58, 1.0] model `minecraft:item/crossbow_pulling_${index}`",
      "    fallback minecraft:item/crossbow",
      "  }",
      "}",
      "item fishing_rod {",
      "  condition property minecraft:fishing_rod/cast {",
      "    on_true minecraft:item/fishing_rod_cast",
      "    on_false minecraft:item/fishing_rod",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const crossbow = result.units.find(unit => unit.outputPath.endsWith("models/item/crossbow.json"));
    assert.deepStrictEqual(crossbow?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { pull: 0.58 },
          model: "minecraft:item/crossbow_pulling_0"
        },
        {
          predicate: { pull: 1 },
          model: "minecraft:item/crossbow_pulling_1"
        }
      ]
    });

    const fishingRod = result.units.find(unit => unit.outputPath.endsWith("models/item/fishing_rod.json"));
    assert.deepStrictEqual(fishingRod?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/fishing_rod"
      },
      overrides: [
        {
          predicate: { cast: 1 },
          model: "minecraft:item/fishing_rod_cast"
        }
      ]
    });
  });

  it("maps main hand selects to legacy lefthanded predicates", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item tool {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:main_hand,",
      "    cases: [",
      "      { when: \"right\", model: { type: minecraft:model, model: minecraft:item/tool_right } },",
      "      { when: \"left\", model: { type: minecraft:model, model: minecraft:item/tool_left } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/tool }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/tool"
      },
      overrides: [
        {
          predicate: { lefthanded: 0 },
          model: "minecraft:item/tool_right"
        },
        {
          predicate: { lefthanded: 1 },
          model: "minecraft:item/tool_left"
        }
      ]
    });
  });

  it("maps charge type selects to legacy crossbow predicates", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item crossbow {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:charge_type,",
      "    cases: [",
      "      { when: \"arrow\", model: { type: minecraft:model, model: minecraft:item/crossbow_arrow } },",
      "      { when: \"rocket\", model: { type: minecraft:model, model: minecraft:item/crossbow_firework } }",
      "    ],",
      "    fallback: {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_false: { type: minecraft:model, model: minecraft:item/crossbow },",
      "      on_true: {",
      "        type: minecraft:range_dispatch,",
      "        property: minecraft:crossbow/pull,",
      "        entries: [",
      "          { threshold: 0.58, model: { type: minecraft:model, model: minecraft:item/crossbow_pulling_1 } },",
      "          { threshold: 1.0, model: { type: minecraft:model, model: minecraft:item/crossbow_pulling_2 } }",
      "        ],",
      "        fallback: { type: minecraft:model, model: minecraft:item/crossbow_pulling_0 }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { pulling: 1 },
          model: "minecraft:item/crossbow_pulling_0"
        },
        {
          predicate: { pulling: 1, pull: 0.58 },
          model: "minecraft:item/crossbow_pulling_1"
        },
        {
          predicate: { pulling: 1, pull: 1 },
          model: "minecraft:item/crossbow_pulling_2"
        },
        {
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow_firework"
        }
      ]
    });

    const arrowOnly = compileRsglModule(parseRsgl([
      "target java format 64",
      "item crossbow {",
      "  model: {",
      "    type: minecraft:select,",
      "    property: minecraft:charge_type,",
      "    cases: [",
      "      { when: \"arrow\", model: { type: minecraft:model, model: minecraft:item/crossbow_arrow } }",
      "    ],",
      "    fallback: { type: minecraft:model, model: minecraft:item/crossbow }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(arrowOnly.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(arrowOnly.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/crossbow"
      },
      overrides: [
        {
          predicate: { charged: 1 },
          model: "minecraft:item/crossbow_arrow"
        },
        {
          predicate: { charged: 1, firework: 1 },
          model: "minecraft:item/crossbow"
        }
      ]
    });
  });

  it("reports unsupported item models in the legacy item backend", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format 64",
      "item bundle {",
      "  selected_item",
      "}"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedLegacyItemModel"));
    assert.deepStrictEqual(result.units, []);
  });

  it("lowers generic JSON resource fragments", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "fragment atlasSource(source: String, prefix: String) {",
      "  use atlasDirectory(source: source, prefix: prefix)",
      "}",
      "atlas minecraft:blocks {",
      "  use atlasSource(\"block\", \"block/\")",
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
      "}",
      "font default {",
      "  providers [",
      "    { type: reference, id: minecraft:include/space },",
      "    { type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }",
      "  ]",
      "}",
      "font include/space {",
      "  providers [{ type: space, advances: { \" \": 4 } }]",
      "}",
      "waypoint_style default {",
      "  near_distance 128",
      "  far_distance 332",
      "  sprites [minecraft:default_0, minecraft:default_1]",
      "}",
      "post_effect blur {",
      "  targets {",
      "    swap: { width: 640, height: 480, persistent: true }",
      "  }",
      "  passes [",
      "    { vertex_shader: minecraft:core/screenquad, fragment_shader: minecraft:post/box_blur, inputs: [{ sampler_name: \"Mask\", location: minecraft:blur/mask, width: 16, height: 16, bilinear: true }], output: \"swap\", uniforms: { BlurDir: [{ name: \"BlurDir\", type: \"vec2\", value: [1, 0] }] } }",
      "  ]",
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
      "assets/minecraft/font/default.json",
      "assets/minecraft/font/include/space.json",
      "assets/minecraft/particles/explosion.json",
      "assets/minecraft/post_effect/blur.json",
      "assets/minecraft/textures/block/high_light.png.mcmeta",
      "assets/minecraft/waypoint_style/default.json"
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
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "assets/minecraft/font/default.json")?.content, {
      providers: [
        { type: "reference", id: "minecraft:include/space" },
        { type: "bitmap", file: "minecraft:font/ascii.png", ascent: 7, chars: ["abc"] }
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "waypoint_style")?.content, {
      ["near_distance"]: 128,
      ["far_distance"]: 332,
      sprites: ["minecraft:default_0", "minecraft:default_1"]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "post_effect")?.content, {
      targets: {
        swap: { width: 640, height: 480, persistent: true }
      },
      passes: [
        {
          ["vertex_shader"]: "minecraft:core/screenquad",
          ["fragment_shader"]: "minecraft:post/box_blur",
          inputs: [
            { ["sampler_name"]: "Mask", location: "minecraft:blur/mask", width: 16, height: 16, bilinear: true }
          ],
          output: "swap",
          uniforms: {
            ["BlurDir"]: [{ name: "BlurDir", type: "vec2", value: [1, 0] }]
          }
        }
      ]
    });
    assert.ok(checkedResources.includes("texture:minecraft:particle/explosion_00"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid_leggings/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:font/ascii.png"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/default_0"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/default_1"));
    assert.ok(checkedResources.includes("shaderVertex:minecraft:core/screenquad"));
    assert.ok(checkedResources.includes("shaderFragment:minecraft:post/box_blur"));
    assert.ok(checkedResources.includes("texture:minecraft:effect/blur/mask"));
    assert.strictEqual(checkedResources.includes("font:minecraft:include/space"), false);
  });

  it("lowers atlas source sugar statements", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "atlas minecraft:blocks {",
      "  directory source \"block\" prefix \"block/\"",
      "  directory source \"potions\" prefix \"potions/\"",
      "  filter namespace \"minecraft\" path \"block/.*_debug\"",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const atlas = result.units.find(unit => unit.kind === "atlas");
    assert.deepStrictEqual(atlas?.content, {
      sources: [
        { type: "minecraft:directory", source: "block", prefix: "block/" },
        { type: "minecraft:directory", source: "potions", prefix: "potions/" },
        {
          type: "minecraft:filter",
          pattern: {
            namespace: "minecraft",
            path: "block/.*_debug"
          }
        }
      ]
    });
    assert.deepStrictEqual(atlas?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/sources",
      "/sources",
      "/sources"
    ]);
    assert.ok(checkedResources.includes("textureDirectory:minecraft:block"));
    assert.ok(checkedResources.includes("textureDirectory:minecraft:potions"));
  });

  it("reports invalid atlas source sugar statements", () => {
    const result = compileRsglModule(parseRsgl([
      "atlas minecraft:blocks {",
      "  directory prefix \"block/\"",
      "  filter namespace \"minecraft\"",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.invalidAtlasDirectorySource",
      "rsgl.invalidAtlasFilter"
    ]);
  });

  it("lowers equipment layer sugar statements", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "equipment minecraft:iron {",
      "  layers [horse_body, humanoid]",
      "  texture minecraft:iron",
      "}",
      "equipment minecraft:leather {",
      "  layer humanoid texture minecraft:leather dyeable color 0xA06500",
      "  layer humanoid texture minecraft:leather_overlay",
      "  layer humanoid_leggings texture minecraft:leather_leggings dyeable color 0xA06500",
      "  layer humanoid_leggings texture minecraft:leather_leggings_overlay",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const iron = result.units.find(unit => unit.outputPath.endsWith("iron.json"));
    const leather = result.units.find(unit => unit.outputPath.endsWith("leather.json"));
    assert.deepStrictEqual(iron?.content, {
      layers: {
        ["horse_body"]: [{ texture: "minecraft:iron" }],
        humanoid: [{ texture: "minecraft:iron" }]
      }
    });
    assert.deepStrictEqual(iron?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/layers"
    ]);
    assert.deepStrictEqual(leather?.content, {
      layers: {
        humanoid: [
          { texture: "minecraft:leather", dyeable: { ["color_when_undyed"]: 10511616 } },
          { texture: "minecraft:leather_overlay" }
        ],
        ["humanoid_leggings"]: [
          { texture: "minecraft:leather_leggings", dyeable: { ["color_when_undyed"]: 10511616 } },
          { texture: "minecraft:leather_leggings_overlay" }
        ]
      }
    });
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/horse_body/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/leather"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid_leggings/leather_leggings_overlay"));
  });

  it("reports invalid equipment layer sugar statements", () => {
    const result = compileRsglModule(parseRsgl([
      "equipment minecraft:broken {",
      "  layer humanoid dyeable",
      "}",
      "equipment minecraft:compact_broken {",
      "  layers [humanoid]",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.invalidEquipmentLayerTexture",
      "rsgl.invalidEquipmentLayersTexture"
    ]);
  });

  it("lowers and validates mcmeta GUI scaling sugar", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/button.png\" {",
      "  use nineSliceGui(width: 200, height: 20, border: 2, stretch_inner: true)",
      "}",
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/panel.png\" {",
      "  gui {",
      "    scaling {",
      "      type tile",
      "      width 16",
      "      height 16",
      "    }",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("button.png.mcmeta"))?.content, {
      gui: {
        scaling: {
          type: "nine_slice",
          width: 200,
          height: 20,
          border: 2,
          ["stretch_inner"]: true
        }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("panel.png.mcmeta"))?.content, {
      gui: {
        scaling: {
          type: "tile",
          width: 16,
          height: 16
        }
      }
    });
  });

  it("reports invalid mcmeta GUI scaling metadata", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/bad.png\" {",
      "  gui {",
      "    scaling {",
      "      type nine_slice",
      "      width 16",
      "      border -1",
      "      stretch_inner \"yes\"",
      "    }",
      "  }",
      "}",
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/bad_helper.png\" {",
      "  use nineSliceGui(width: \"wide\", height: 10, border: 1)",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidMcmetaGuiScaling"));
    assert.ok(codes.includes("rsgl.invalidJsonResourceFragmentArgument"));
  });

  it("expands mcmeta glob targets relative to the resource pack root", () => {
    const root = createTempDir();
    try {
      const rsglDir = path.join(root, "rsgl");
      const textureDir = path.join(root, "assets", "minecraft", "textures", "block");
      fs.mkdirSync(rsglDir, { recursive: true });
      fs.mkdirSync(textureDir, { recursive: true });
      fs.writeFileSync(path.join(root, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(textureDir, "glow_0.png"), "");
      fs.writeFileSync(path.join(textureDir, "glow_1.png"), "");
      fs.writeFileSync(path.join(textureDir, "other.png"), "");

      const mainFile = path.join(rsglDir, "main.rsgl");
      fs.writeFileSync(mainFile, [
        "mcmeta glob(\"assets/minecraft/textures/block/glow_*.png\") {",
        "  use mcmetaAnimation(frametime: 3)",
        "}"
      ].join("\n"));
      const checkedResources: string[] = [];
      const result = compileRsglFile(mainFile, {
        resourceExists: (kind, id) => {
          checkedResources.push(`${kind}:${id}`);
          return true;
        }
      });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/textures/block/glow_0.png.mcmeta",
        "assets/minecraft/textures/block/glow_1.png.mcmeta"
      ]);
      for (const unit of result.units) {
        assert.deepStrictEqual(unit.content, {
          animation: {
            frametime: 3
          }
        });
      }
      assert.ok(checkedResources.includes("texture:minecraft:block/glow_0"));
      assert.ok(checkedResources.includes("texture:minecraft:block/glow_1"));

      fs.writeFileSync(mainFile, [
        "mcmeta glob(\"assets/minecraft/textures/block/missing_*.png\") {",
        "  animation { frametime 1 }",
        "}"
      ].join("\n"));
      const empty = compileRsglFile(mainFile);

      assert.ok(empty.diagnostics.some(diagnostic => diagnostic.code === "rsgl.mcmetaGlobNoMatches"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("reports recursive template expansion during compilation", () => {
    const result = compileRsglModule(parseRsgl([
      "template a() {",
      "  use b()",
      "}",
      "template b() {",
      "  use a()",
      "}",
      "use a()"
    ].join("\n")));

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.templateRecursion"));
    assert.deepStrictEqual(result.units, []);
  });

  it("does not generate resources from modules with syntax errors", () => {
    const result = compileRsglModule(parseRsgl([
      "model block valid {",
      "  parent minecraft:block/cube_all",
      "}",
      "blockstate minecraft:legacy {",
      "  variants {",
      "    `age=${age}` {",
      "      @minecraft:block/crop",
      "    }",
      "  }",
      "}"
    ].join("\n")));
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.deepStrictEqual(result.units, []);
    assert.ok(codes.includes("rsgl.expectedToken"));
    assert.strictEqual(codes.includes("rsgl.undefinedSymbol"), false);
  });

  it("expands local resource body fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "fragment cubeFields(parentModel: ModelId, texture: TextureId = minecraft:block/stone) {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}",
      "model block stone {",
      "  use cubeFields(minecraft:block/cube_all)",
      "}"
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

  it("reports invalid fragment call arguments during compilation", () => {
    const result = compileRsglModule(parseRsgl([
      "fragment cubeFields(parentModel: ModelId, texture: TextureId) {",
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
    ].join("\n")));
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

  it("records source map entries for resource body raw_json and loops", () => {
    const result = compileRsglModule(parseRsgl([
      "model block mapped {",
      "  raw_json { \"base/key\": true }",
      "  textures {",
      "    for layer in [{ key: \"layer/zero\", tex: minecraft:block/stone }, { key: \"layer1\", tex: minecraft:block/dirt }] {",
      "      raw_json { [layer.key]: layer.tex }",
      "    }",
      "  }",
      "}"
    ].join("\n")), { fileName: path.resolve("pack", "main.rsgl") });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/base~1key",
      "/textures",
      "/textures/layer~1zero",
      "/textures/layer1"
    ]);

    const loopMappings = result.units[0].sourceMap.mappings.filter(mapping => mapping.reason === "loop");
    assert.deepStrictEqual(loopMappings.map(mapping => mapping.generatedPath), [
      "/textures/layer~1zero",
      "/textures/layer1"
    ]);
    assert.ok(loopMappings.every(mapping => mapping.expansionStack.some(frame => frame.label === "for")));
  });

  it("enforces override create and append merge semantics in resource bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "model block patched {",
      "  parent minecraft:block/cube_all",
      "  textures { all minecraft:block/stone }",
      "  layers [{ texture: minecraft:block/base }]",
      "  override { parent: minecraft:block/overridden }",
      "  override create { display: { gui: { scale: [1, 1, 1] } } }",
      "  append { textures: { particle: minecraft:block/stone } }",
      "  append { layers: [{ texture: minecraft:block/overlay }] }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/overridden",
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
          scale: [1, 1, 1]
        }
      }
    });
  });

  it("reports invalid override and append fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "model block invalid {",
      "  parent minecraft:block/cube_all",
      "  override { textures: { all: minecraft:block/stone } }",
      "  append { parent: minecraft:block/other }",
      "  raw_json 1",
      "  override 2",
      "  append 3",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.overrideMissingField"));
    assert.ok(codes.includes("rsgl.appendIncompatibleField"));
    assert.ok(codes.includes("rsgl.invalidRawJsonFragment"));
    assert.ok(codes.includes("rsgl.invalidOverrideFragment"));
    assert.ok(codes.includes("rsgl.invalidAppendFragment"));
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all"
    });
  });

  it("applies override create and append semantics in blockstate bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    { facing: north } -> { model: minecraft:block/lamp, x: 0 }",
      "  }",
      "  override { variants: { \"facing=north\": { model: minecraft:block/lamp_changed } } }",
      "  override create { variants: { \"facing=south\": { model: minecraft:block/lamp_south } } }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    apply { model: minecraft:block/fence_post }",
      "  }",
      "  append { multipart: [{ when: { north: true }, apply: { model: minecraft:block/fence_side } }] }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: {
          model: "minecraft:block/lamp_changed",
          x: 0
        },
        ["facing=south"]: {
          model: "minecraft:block/lamp_south"
        }
      }
    });

    const fence = result.units.find(unit => unit.outputPath.endsWith("fence.json"));
    assert.deepStrictEqual(fence?.content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/fence_post"
          }
        },
        {
          apply: {
            model: "minecraft:block/fence_side"
          },
          when: {
            north: true
          }
        }
      ]
    });
    assert.ok(fence?.sourceMap.mappings.some(mapping => mapping.generatedPath === "/multipart/1"));
  });

  it("reports invalid blockstate override and append fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate invalid_variants {",
      "  variants {",
      "    {} -> { model: minecraft:block/base }",
      "  }",
      "  override { variants: { \"facing=north\": { model: minecraft:block/new } } }",
      "  append { variants: { \"facing=south\": { model: minecraft:block/south } } }",
      "  raw_json 1",
      "  override 2",
      "  append 3",
      "}",
      "blockstate invalid_multipart {",
      "  multipart {",
      "    apply { model: minecraft:block/post }",
      "  }",
      "  append { multipart: { apply: { model: minecraft:block/side } } }",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.overrideMissingField"));
    assert.ok(codes.includes("rsgl.appendIncompatibleField"));
    assert.ok(codes.includes("rsgl.invalidRawJsonFragment"));
    assert.ok(codes.includes("rsgl.invalidOverrideFragment"));
    assert.ok(codes.includes("rsgl.invalidAppendFragment"));
    assert.ok(codes.includes("rsgl.invalidBlockstateMultipartFragment"));

    const invalidVariants = result.units.find(unit => unit.outputPath.endsWith("invalid_variants.json"));
    assert.deepStrictEqual(invalidVariants?.content, {
      variants: {
        [""]: {
          model: "minecraft:block/base"
        }
      }
    });
    const invalidMultipart = result.units.find(unit => unit.outputPath.endsWith("invalid_multipart.json"));
    assert.deepStrictEqual(invalidMultipart?.content, {
      multipart: [
        {
          apply: {
            model: "minecraft:block/post"
          }
        }
      ]
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
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath).sort(), [
      "",
      "/variants",
      "/variants/facing=east,powered=false",
      "/variants/facing=east,powered=true",
      "/variants/facing=north,powered=false",
      "/variants/facing=north,powered=true"
    ].sort());
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => mapping.generatedPath.startsWith("/variants/facing="))
      .map(mapping => mapping.reason), ["loop", "loop", "loop", "loop"]);
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
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/multipart",
      "/multipart/0",
      "/multipart/1",
      "/multipart/2",
      "/multipart/3"
    ]);
    assert.deepStrictEqual(result.units[0].sourceMap.mappings
      .filter(mapping => mapping.generatedPath === "/multipart/1" || mapping.generatedPath === "/multipart/2")
      .map(mapping => mapping.reason), ["loop", "loop"]);
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
      "blockstate furnace {",
      "  use horizontalFacing(model: minecraft:block/furnace, state: { lit: false })",
      "}",
      "blockstate oak_log {",
      "  use axisRotated(vertical: minecraft:block/oak_log, horizontal: minecraft:block/oak_log_horizontal)",
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
    const furnace = result.units.find(unit => unit.outputPath.endsWith("furnace.json"));
    const log = result.units.find(unit => unit.outputPath.endsWith("oak_log.json"));
    const leaves = result.units.find(unit => unit.outputPath.endsWith("oak_leaves.json"));
    assert.ok(stairs);
    assert.ok(fence);
    assert.ok(fenceGate);
    assert.ok(door);
    assert.ok(trapdoor);
    assert.ok(pane);
    assert.ok(furnace);
    assert.ok(log);
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
    assert.deepStrictEqual(furnace.content, {
      variants: {
        ["facing=east,lit=false"]: { model: "minecraft:block/furnace", y: 90 },
        ["facing=north,lit=false"]: { model: "minecraft:block/furnace" },
        ["facing=south,lit=false"]: { model: "minecraft:block/furnace", y: 180 },
        ["facing=west,lit=false"]: { model: "minecraft:block/furnace", y: 270 }
      }
    });
    assert.deepStrictEqual(log.content, {
      variants: {
        ["axis=x"]: { model: "minecraft:block/oak_log_horizontal", x: 90, y: 90 },
        ["axis=y"]: { model: "minecraft:block/oak_log" },
        ["axis=z"]: { model: "minecraft:block/oak_log_horizontal", x: 90 }
      }
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

  it("expands user blockstate section fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "fragment lampFacing(modelId: ModelId, states: Json = HORIZONTAL) {",
      "  variants {",
      "    for facing in states {",
      "      { facing: facing } -> { model: modelId, y: yaw(facing) }",
      "    }",
      "  }",
      "}",
      "fragment connectedPane(post: ModelId, side: ModelId) {",
      "  multipart {",
      "    apply { model: post }",
      "    for facing in [north, east] {",
      "      when { [facing]: true } apply { model: side, y: yaw(facing) }",
      "    }",
      "  }",
      "}",
      "blockstate lamp {",
      "  variants {",
      "    use lampFacing(minecraft:block/lamp)",
      "  }",
      "}",
      "blockstate pane {",
      "  use connectedPane(minecraft:block/pane_post, minecraft:block/pane_side)",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    const pane = result.units.find(unit => unit.outputPath.endsWith("pane.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: { model: "minecraft:block/lamp", y: 0 },
        ["facing=east"]: { model: "minecraft:block/lamp", y: 90 },
        ["facing=south"]: { model: "minecraft:block/lamp", y: 180 },
        ["facing=west"]: { model: "minecraft:block/lamp", y: 270 }
      }
    });
    assert.deepStrictEqual(pane?.content, {
      multipart: [
        { apply: { model: "minecraft:block/pane_post" } },
        { when: { north: true }, apply: { model: "minecraft:block/pane_side", y: 0 } },
        { when: { east: true }, apply: { model: "minecraft:block/pane_side", y: 90 } }
      ]
    });
  });

  it("supports parameterized blockstate sugar used by real-world fragments", () => {
    const result = compileRsglModule(parseRsgl([
      "let suffix = \"lamp\"",
      "fragment keyed(property: String, prop1: String, modelId: ModelId) {",
      "  variants {",
      "    [property=full prop1=false] ->",
      "      @modelId y=yaw(east)",
      "  }",
      "}",
      "blockstate example {",
      "  use keyed(\"tilt\", \"powered\", `minecraft:block/${suffix}`)",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        ["powered=false,tilt=full"]: {
          model: "minecraft:block/lamp",
          y: 90
        }
      }
    });
  });

  it("parses newline blockstate values and comma-separated random apply entries", () => {
    const result = compileRsglModule(parseRsgl([
      "let block = \"powder_snow\"",
      "blockstate snow {",
      "  variants {",
      "    {} ->",
      "      random [",
      "        @`minecraft:block/${block}`, @`minecraft:block/${block}` y=90,",
      "        @`minecraft:block/${block}` y=180, @`minecraft:block/${block}` y=270",
      "      ]",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    const defaultVariantKey = "";
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        [defaultVariantKey]: [
          { model: "minecraft:block/powder_snow" },
          { model: "minecraft:block/powder_snow", y: 90 },
          { model: "minecraft:block/powder_snow", y: 180 },
          { model: "minecraft:block/powder_snow", y: 270 }
        ]
      }
    });
  });

  it("evaluates local let declarations inside multipart sections", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate sensor {",
      "  multipart {",
      "    let poweredStates = \"1|2|3\"",
      "    when { power: poweredStates } apply @minecraft:block/sensor_powered",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          when: { power: "1|2|3" },
          apply: { model: "minecraft:block/sensor_powered" }
        }
      ]
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

  it("reports invalid blockstate template state arguments", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate broken {",
      "  use horizontalFacing(model: minecraft:block/furnace, state: [north])",
      "  use axisRotated(vertical: minecraft:block/oak_log, horizontal: minecraft:block/oak_log_horizontal, state: { axis: x })",
      "}",
    ].join("\n")));
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidTemplateStateArgument"));
    assert.ok(codes.includes("rsgl.templateStateConflict"));
  });

  it("emits pack, lang, sounds, and mcmeta resources", () => {
    const result = compileRsglModule(parseRsgl([
      "pack {",
      "  description \"Generated pack\"",
      "  min_format [88, 0]",
      "  max_format [88, 0]",
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
        ["min_format"]: [88, 0],
        ["max_format"]: [88, 0]
      }
    });
    assert.deepStrictEqual(pack?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/pack/description",
      "/pack/min_format",
      "/pack/max_format"
    ]);

    const expectedLang = {
      ["block.minecraft.stone"]: "Stone",
      ["item.minecraft.stick"]: "Stick"
    };
    const lang = result.units.find(unit => unit.kind === "lang");
    assert.deepStrictEqual(lang?.content, expectedLang);
    assert.deepStrictEqual(lang?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/block.minecraft.stone",
      "",
      "/item.minecraft.stick"
    ]);

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

  it("validates lang and sounds resource structure", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "lang en_us {",
      "  \"valid.key\" \"Valid\"",
      "  raw_json { \"bad.key\": 1 }",
      "}",
      "lang deprecated {",
      "  raw_json { removed: [\"old.key\", 1], renamed: { \"old.key\": 2 } }",
      "}",
      "sounds custom {",
      "  \"valid.event\" { sounds: [\"entity/example/valid\"] }",
      "  \"bad.event\" {",
      "    replace: \"yes\"",
      "    subtitle: 1",
      "    sounds: [",
      "      \"entity/example/bad sound.ogg\",",
      "      { type: \"event\", name: \"missing.event\" },",
      "      { type: \"bad\", name: 1, volume: 0, pitch: -1, weight: 0, attenuation_distance: 0, preload: \"yes\", stream: 1 },",
      "      1",
      "    ]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidLangValue"));
    assert.ok(codes.includes("rsgl.invalidLangDeprecated"));
    assert.ok(codes.includes("rsgl.invalidSoundsEventField"));
    assert.ok(codes.includes("rsgl.invalidSoundReference"));
    assert.ok(codes.includes("rsgl.soundEventNotFound"));
    assert.ok(codes.includes("rsgl.invalidSoundField"));
    assert.ok(codes.includes("rsgl.missingSoundName"));
    assert.ok(codes.includes("rsgl.invalidSoundEntry"));
    assert.ok(codes.includes("rsgl.soundNotFound"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/valid"));
  });

  it("validates sound metadata through compiler hooks", () => {
    const result = compileRsglModule(parseRsgl([
      "sounds custom {",
      "  \"entity.example\" {",
      "    sounds: [",
      "      \"entity/example/unreadable\",",
      "      \"entity/example/bad_shape\",",
      "      \"entity/example/valid\"",
      "    ]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      soundMetadata: id => {
        if (id.endsWith("unreadable")) {
          return null;
        }
        if (id.endsWith("bad_shape")) {
          return { codec: "opus", channels: 0, sampleRate: 0, durationSeconds: -1 };
        }
        return { codec: "vorbis", channels: 2, sampleRate: 44100, durationSeconds: 1 };
      }
    });

    const invalidSoundMetadata = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.invalidSoundMetadata");
    assert.strictEqual(invalidSoundMetadata.length, 5);
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("could not be read")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("unsupported codec")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("channel count")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("sample rate")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("duration")));
  });

  it("validates font provider resources", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "font invalid {",
      "  providers [",
      "    1,",
      "    { type: unknown },",
      "    { type: bitmap },",
      "    { type: bitmap, file: minecraft:font/missing.png, chars: [1], ascent: \"bad\", shift: [0, 999], filter: { uniform: \"yes\" } },",
      "    { type: reference, id: minecraft:missing_font },",
      "    { type: ttf, file: example:missing.ttf, skip: [1] },",
      "    { type: unihex, hex_file: example:missing.hex, size_overrides: [{ left: -1, right: 33, ranges: [1] }] },",
      "    { type: space, advances: { \" \": \"wide\" } }",
      "  ]",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidFontProvider"));
    assert.ok(codes.includes("rsgl.invalidFontProviderType"));
    assert.ok(codes.includes("rsgl.missingFontProviderField"));
    assert.ok(codes.includes("rsgl.invalidFontProviderField"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.fontNotFound"));
    assert.ok(codes.includes("rsgl.fontFileNotFound"));
    assert.ok(checkedResources.includes("texture:minecraft:font/missing.png"));
    assert.ok(checkedResources.includes("font:minecraft:missing_font"));
    assert.ok(checkedResources.includes("fontFile:example:missing.ttf"));
    assert.ok(checkedResources.includes("fontFile:example:missing.hex"));
  });

  it("validates waypoint style resources", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "waypoint_style invalid {",
      "  near_distance 400",
      "  far_distance 100",
      "  sprites [minecraft:missing, 1, \"\"]",
      "}",
      "waypoint_style missing {",
      "  near_distance -1",
      "  far_distance \"bad\"",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidWaypointDistance"));
    assert.ok(codes.includes("rsgl.invalidWaypointDistanceRange"));
    assert.ok(codes.includes("rsgl.invalidWaypointSprite"));
    assert.ok(codes.includes("rsgl.missingWaypointSprites"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/missing"));
  });

  it("validates post effect resources", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "post_effect invalid {",
      "  targets {",
      "    swap: { width: 0, height: \"bad\", persistent: \"yes\", clear_color: [1, 2, 3] }",
      "  }",
      "  passes [",
      "    1,",
      "    { vertex_shader: 1, fragment_shader: minecraft:post/missing, inputs: 1, uniforms: [] },",
      "    { vertex_shader: minecraft:core/missing, fragment_shader: minecraft:post/missing, output: \"swap\", inputs: [",
      "      1,",
      "      { sampler_name: 1, target: \"missing\", location: minecraft:missing, width: 0, height: \"bad\", use_depth_buffer: \"yes\", bilinear: \"no\" },",
      "      { target: \"swap\" }",
      "    ], uniforms: { Bad: [1, { name: 1, type: \"bad\", value: [\"bad\"] }] } },",
      "    { output: \"missing\", inputs: [{ target: \"missing\" }] }",
      "  ]",
      "}",
      "post_effect invalid_shapes {",
      "  raw_json { targets: [], passes: {} }",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidPostEffectTargetField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPasses"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPass"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPassField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInputs"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInput"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInputField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectUniform"));
    assert.ok(codes.includes("rsgl.invalidPostEffectUniformField"));
    assert.ok(codes.includes("rsgl.postEffectTargetNotFound"));
    assert.ok(codes.includes("rsgl.invalidPostEffectTargetFlow"));
    assert.ok(codes.includes("rsgl.vertexShaderNotFound"));
    assert.ok(codes.includes("rsgl.fragmentShaderNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(checkedResources.includes("shaderVertex:minecraft:core/missing"));
    assert.ok(checkedResources.includes("shaderFragment:minecraft:post/missing"));
    assert.ok(checkedResources.includes("texture:minecraft:effect/missing"));
  });

  it("validates pack metadata formats and filters", () => {
    const result = compileRsglModule(parseRsgl([
      "target java format [75, 0]",
      "pack {",
      "  pack {",
      "    description: \"Invalid\"",
      "    min_format: [66, 0]",
      "    max_format: [70, 0]",
      "    pack_format: 88",
      "    supported_formats: [1, 63]",
      "  }",
      "  filter {",
      "    block: [{ namespace: \"[\", path: \"*\" }]",
      "  }",
      "  overlays {",
      "    entries: [",
      "      { directory: \"legacy\", formats: [2, 1] },",
      "      { directory: \"old\", formats: [1, 64] }",
      "    ]",
      "  }",
      "}"
    ].join("\n")));
    const modernPackFormat = compileRsglModule(parseRsgl([
      "pack {",
      "  description \"Invalid\"",
      "  pack_format 88",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unsupportedPackFormatFields"));
    assert.ok(codes.includes("rsgl.packOutsideTargetFormat"));
    assert.ok(codes.includes("rsgl.invalidPackFilterPattern"));
    assert.ok(codes.includes("rsgl.invalidOverlayFormatRange"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
    assert.ok(modernPackFormat.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.invalidPackFormatField"));
  });

  it("lowers pack metadata sugar to root pack.mcmeta sections", () => {
    const result = compileRsglModule(parseRsgl([
      "pack {",
      "  description \"Generated pack\"",
      "  formats min [88, 0] max [9999, 0]",
      "  overlay \"format_75\" {",
      "    formats min [75, 0] max [87, 9999]",
      "  }",
      "  filter {",
      "    block namespace \"minecraft\" path \"textures/block/stone.*\"",
      "  }",
      "}"
    ].join("\n")));
    const pack = result.units.find(unit => unit.kind === "pack");

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(pack?.content, {
      pack: {
        description: "Generated pack",
        ["min_format"]: [88, 0],
        ["max_format"]: [9999, 0]
      },
      overlays: {
        entries: [{
          directory: "format_75",
          ["min_format"]: [75, 0],
          ["max_format"]: [87, 9999]
        }]
      },
      filter: {
        block: [{
          namespace: "minecraft",
          path: "textures/block/stone.*"
        }]
      }
    });
    const paths = pack?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(paths.includes("/pack/description"));
    assert.ok(paths.includes("/pack/min_format"));
    assert.ok(paths.includes("/pack/max_format"));
    assert.ok(paths.includes("/overlays"));
    assert.ok(paths.includes("/filter"));
    assert.ok(paths.includes("/filter/block"));
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
    assert.deepStrictEqual(model?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/all"
    ]);
    assert.deepStrictEqual(model?.sourceMap.mappings.map(mapping => mapping.expansionStack.map(frame => frame.label)), [
      ["overlay future"],
      ["overlay future"],
      ["overlay future"],
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

  it("reports duplicate overlay directories at the duplicate overlay declaration", () => {
    const source = [
      "overlay \"future\" {",
      "  model block stone { parent minecraft:block/cube_all }",
      "}",
      "overlay \"future\" {",
      "  item stone { model minecraft:block/stone }",
      "}"
    ].join("\n");
    const secondOverlayStart = source.indexOf("overlay \"future\"", source.indexOf("overlay \"future\"") + 1);
    const result = compileRsglModule(parseRsgl(source));
    const duplicate = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.duplicateOverlayDirectory");
    const pack = result.units.find(unit => unit.outputPath === "pack.mcmeta");

    assert.ok(duplicate);
    assert.strictEqual(duplicate.range.start, secondOverlayStart);
    assert.deepStrictEqual(pack?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "/overlays/entries/0",
      "/overlays/entries/1"
    ]);
  });

  it("reports non-finite loops inside resource bodies", () => {
    const result = compileRsglModule(parseRsgl([
      "model block bad {",
      "  for item in 1 {",
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

  it("expands imported resource body fragments with definition-file defaults", () => {
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
          "let defaultTexture = block/stone",
          "fragment cubeFields(texture: TextureId = defaultTexture) {",
          "  textures { all: texture }",
          "}",
          "export { cubeFields }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/app/models/block/stone.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "library:block/stone"
      }
    });
  });

  it("maps imported resource body fragment fields to definition files", () => {
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
          "fragment modelFields(parentModel: ModelId) {",
          "  parent parentModel",
          "}",
          "fragment textureLayer(key: String, texture: TextureId) {",
          "  raw_json { [key]: texture }",
          "}",
          "export { modelFields, textureLayer }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        ["layer/zero"]: "minecraft:block/stone"
      }
    });
    assert.deepStrictEqual(result.units[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/layer~1zero"
    ]);

    const parentMapping = result.units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/parent");
    assert.strictEqual(parentMapping?.sourceFile, fragmentsFile);
    assert.strictEqual(parentMapping?.reason, "template");
    assert.deepStrictEqual(parentMapping?.expansionStack.map(frame => frame.label), ["fragment modelFields"]);

    const texturesMapping = result.units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures");
    assert.strictEqual(texturesMapping?.sourceFile, mainFile);
    assert.strictEqual(texturesMapping?.reason, "direct");

    const layerMapping = result.units[0].sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/layer~1zero");
    assert.strictEqual(layerMapping?.sourceFile, fragmentsFile);
    assert.strictEqual(layerMapping?.reason, "template");
    assert.deepStrictEqual(layerMapping?.expansionStack.map(frame => frame.label), ["fragment textureLayer"]);
  });

  it("preserves imported fragment environments inside resource body loops", () => {
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
          "fragment textureLayer(texture: TextureId) {",
          "  textures { layer0: texture }",
          "}",
          "fragment generatedLayers(textures: Json = [block/stone, block/dirt]) {",
          "  parent minecraft:item/generated",
          "  for texture in textures {",
          "    use textureLayer(texture)",
          "  }",
          "}",
          "export { generatedLayers }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/app/models/item/layered.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "library:block/dirt"
      }
    });
  });

  it("expands imported blockstate section fragments with definition-file defaults", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import { connectedPane, lampFacing } from \"./fragments.rsgl\"",
          "blockstate lamp {",
          "  variants {",
          "    use lampFacing()",
          "  }",
          "}",
          "blockstate pane {",
          "  multipart {",
          "    apply { model: minecraft:block/pane_post }",
          "    use connectedPane()",
          "  }",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "let defaultModel = block/lamp",
          "fragment lampFacing(modelId: ModelId = defaultModel) {",
          "  variants {",
          "    { facing: north } -> { model: modelId }",
          "  }",
          "}",
          "fragment connectedPane(side: ModelId = block/pane_side) {",
          "  multipart {",
          "    for facing in [north, east] {",
          "      when { [facing]: true } apply { model: side, y: yaw(facing) }",
          "    }",
          "  }",
          "}",
          "export { connectedPane, lampFacing }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/app/blockstates/lamp.json",
      "assets/app/blockstates/pane.json"
    ]);

    const lamp = result.units.find(unit => unit.outputPath.endsWith("lamp.json"));
    assert.deepStrictEqual(lamp?.content, {
      variants: {
        ["facing=north"]: { model: "library:block/lamp" }
      }
    });
    assert.deepStrictEqual(lamp?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/variants",
      "/variants/facing=north"
    ]);
    const lampVariant = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north");
    assert.strictEqual(lampVariant?.sourceFile, fragmentsFile);
    assert.strictEqual(lampVariant?.reason, "template");
    assert.deepStrictEqual(lampVariant?.expansionStack.map(frame => frame.label), ["fragment lampFacing"]);

    const pane = result.units.find(unit => unit.outputPath.endsWith("pane.json"));
    assert.deepStrictEqual(pane?.content, {
      multipart: [
        { apply: { model: "minecraft:block/pane_post" } },
        { apply: { model: "library:block/pane_side", y: 0 }, when: { north: true } },
        { apply: { model: "library:block/pane_side", y: 90 }, when: { east: true } }
      ]
    });
    assert.deepStrictEqual(pane?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/multipart",
      "/multipart/0",
      "/multipart/1",
      "/multipart/2"
    ]);
    const paneFragmentMappings = pane?.sourceMap.mappings.filter(mapping =>
      mapping.generatedPath === "/multipart/1" || mapping.generatedPath === "/multipart/2"
    ) ?? [];
    assert.deepStrictEqual(paneFragmentMappings.map(mapping => mapping.sourceFile), [fragmentsFile, fragmentsFile]);
    assert.deepStrictEqual(paneFragmentMappings.map(mapping => mapping.reason), ["template", "template"]);
    assert.ok(paneFragmentMappings.every(mapping => mapping.expansionStack.some(frame => frame.label === "fragment connectedPane")));
  });

  it("imports exported fragments from bare import modules", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace app",
          "import \"./fragments.rsgl\"",
          "blockstate lamp {",
          "  use keyed(\"tilt\", `minecraft:block/${\"lamp\"}`)",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "namespace library",
          "fragment keyed(property: String, modelId: ModelId) {",
          "  variants {",
          "    [property=full] -> @modelId",
          "  }",
          "}",
          "export { keyed }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units[0].content, {
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
    const root = createTempDir();
    try {
      const mainFile = path.join(root, "main.rsgl");

      fs.writeFileSync(path.join(root, "bad_when.json"), JSON.stringify({
        multipart: [
          {
            when: [],
            apply: { model: "minecraft:block/missing_empty_when" }
          }
        ]
      }));

      const result = compileRsglModule(parseRsgl([
        "model block stone {",
        "  parent minecraft:block/missing_parent",
        "  textures { all: minecraft:block/missing_texture }",
        "}",
        "blockstate stone {",
        "  variants {",
        "    {} -> { model: minecraft:block/missing_model, z: 90, weight: 0 }",
        "  }",
        "}",
        "blockstate malformed {",
        "  raw_json {",
        "    variants: {",
        "      \"facing=north,facing=south\": { model: minecraft:block/missing_duplicate, x: 45, uvlock: \"yes\" }",
        "      \"broken\": { model: minecraft:block/missing_broken, y: 45 }",
        "    }",
        "    multipart: [",
        "      { apply: [{ model: minecraft:block/missing_part, z: 45, weight: -1 }] }",
        "    ]",
        "  }",
        "}",
        "blockstate bad_when {",
        "  raw_json {",
        "    multipart: [",
        "      { when: {}, apply: { model: minecraft:block/missing_empty_condition } },",
        "      { when: { OR: [], north: true }, apply: { model: minecraft:block/missing_mixed } },",
        "      { when: { AND: [{ north: true }, []] }, apply: { model: minecraft:block/missing_nested } },",
        "      { when: { east: \"true||false\" }, apply: { model: minecraft:block/missing_value } }",
        "    ]",
        "  }",
        "}",
        "blockstate bad_when_file {",
        "  raw_json(\"./bad_when.json\")",
        "}"
      ].join("\n")), {
        fileName: mainFile,
        targetPackFormat: { major: 74 },
        resourceExists: () => false
      });

      const codes = result.diagnostics.map(diagnostic => diagnostic.code);
      assert.ok(codes.includes("rsgl.modelNotFound"));
      assert.ok(codes.includes("rsgl.textureNotFound"));
      assert.ok(codes.includes("rsgl.unsupportedBlockstateZRotation"));
      assert.ok(codes.includes("rsgl.invalidRandomWeight"));
      assert.ok(codes.includes("rsgl.invalidBlockstateRotation"));
      assert.ok(codes.includes("rsgl.invalidBlockstateUvlock"));
      assert.ok(codes.includes("rsgl.invalidBlockstateVariantKey"));
      assert.ok(codes.includes("rsgl.duplicateBlockstateVariantProperty"));
      assert.ok(codes.includes("rsgl.emptyBlockstateWhen"));
      assert.ok(codes.includes("rsgl.invalidBlockstateWhen"));
      assert.ok(codes.includes("rsgl.mixedBlockstateWhenCondition"));
      assert.ok(codes.includes("rsgl.invalidBlockstateLogicalCondition"));
      assert.ok(codes.includes("rsgl.invalidBlockstateWhenValue"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates blockstate state names, values, and inferred domains", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate invalid_variant_states {",
      "  raw_json {",
      "    variants: {",
      "      \"bad-state=north\": { model: minecraft:block/stone }",
      "      \"facing=North\": { model: minecraft:block/stone }",
      "      \"powered=true\": { model: minecraft:block/stone }",
      "      \"powered=on\": { model: minecraft:block/stone }",
      "    }",
      "  }",
      "}",
      "blockstate invalid_when_states {",
      "  raw_json {",
      "    multipart: [",
      "      { when: { facing: \"north|north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { facing: \"north|!north\" }, apply: { model: minecraft:block/stone } },",
      "      { when: { AND: [{ facing: \"north\" }, { facing: \"!north\" }] }, apply: { model: minecraft:block/stone } }",
      "    ]",
      "  }",
      "}"
    ].join("\n")));

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidBlockstateStateProperty"));
    assert.ok(codes.includes("rsgl.invalidBlockstateStateValue"));
    assert.ok(codes.includes("rsgl.mixedBlockstateStateValueDomain"));
    assert.ok(codes.includes("rsgl.duplicateBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.tautologicalBlockstateWhenValue"));
    assert.ok(codes.includes("rsgl.contradictoryBlockstateWhenCondition"));
  });

  it("validates blockstate states against supplied schemas", () => {
    const schemaRequests: string[] = [];
    const schemas: Record<string, { properties: Record<string, readonly string[]> }> = {
      lamp: {
        properties: {
          facing: ["north", "south"],
          lit: ["true", "false"]
        }
      },
      fence: {
        properties: {
          north: ["true", "false"]
        }
      }
    };
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    [facing=north lit=true] -> { model: minecraft:block/lamp }",
      "    [facing=up lit=maybe bogus=true] -> { model: minecraft:block/lamp }",
      "  }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    when { north: true, side: east } apply { model: minecraft:block/fence_side }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      blockstateSchema: id => {
        schemaRequests.push(`${id.namespace}:${id.path}`);
        return schemas[id.path] ?? null;
      }
    });

    assert.deepStrictEqual(schemaRequests.sort(), ["minecraft:fence", "minecraft:lamp"]);
    assert.strictEqual(result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue").length, 2);
    assert.strictEqual(result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.unknownBlockstateStateProperty").length, 2);

    const lamp = result.units.find(unit => unit.outputPath.endsWith("blockstates/lamp.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("blockstates/fence.json"));
    const invalidVariantRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/bogus=true,facing=up,lit=maybe")?.sourceRange;
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0")?.sourceRange;

    assert.ok(invalidVariantRange);
    assert.ok(multipartRange);
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("'facing' does not allow value 'up'"))?.range,
      invalidVariantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("'side' is not defined"))?.range,
      multipartRange
    );
  });

  it("infers blockstate schemas from existing JSON content", () => {
    assert.deepStrictEqual(inferBlockstateSchemaFromContent({
      variants: {
        ["facing=north,lit=true"]: { model: "minecraft:block/lamp" },
        ["facing=south,lit=false"]: { model: "minecraft:block/lamp" }
      },
      multipart: [
        { when: { north: true }, apply: { model: "minecraft:block/fence" } },
        { when: { ["OR"]: [{ side: "east|west" }, { side: "!north" }] }, apply: { model: "minecraft:block/fence" } }
      ]
    }), {
      properties: {
        facing: ["north", "south"],
        lit: ["false", "true"],
        north: ["true"],
        side: ["east", "north", "west"]
      }
    });
    assert.strictEqual(inferBlockstateSchemaFromContent({ variants: { [""]: { model: "minecraft:block/stone" } } }), null);
  });

  it("maps blockstate validation diagnostics to generated entry source ranges", () => {
    const result = compileRsglModule(parseRsgl([
      "blockstate lamp {",
      "  variants {",
      "    [facing=north] -> { model: minecraft:block/missing_variant, x: 45 }",
      "  }",
      "}",
      "blockstate fence {",
      "  multipart {",
      "    when { north: \"true||false\" } apply { model: minecraft:block/missing_multipart, z: 45 }",
      "  }",
      "}"
    ].join("\n")), {
      targetPackFormat: { major: 74 },
      resourceExists: () => false
    });

    const lamp = result.units.find(unit => unit.outputPath.endsWith("blockstates/lamp.json"));
    const fence = result.units.find(unit => unit.outputPath.endsWith("blockstates/fence.json"));
    const variantRange = lamp?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants/facing=north")?.sourceRange;
    const multipartRange = fence?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart/0")?.sourceRange;

    assert.ok(variantRange);
    assert.ok(multipartRange);
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateRotation")?.range,
      variantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_variant"))?.range,
      variantRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidBlockstateWhenValue")?.range,
      multipartRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation")?.range,
      multipartRange
    );
    assert.deepStrictEqual(
      result.diagnostics.find(diagnostic => diagnostic.message.includes("missing_multipart"))?.range,
      multipartRange
    );
  });

  it("validates model display, element geometry, rotation, and face fields", () => {
    const valid = compileRsglModule(parseRsgl([
      "model block valid_geometry {",
      "  display {",
      "    gui: { rotation: [30, 45, 0], translation: [0, 0, 0], scale: [1, 1, 1] }",
      "    on_shelf: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] }",
      "  }",
      "  textures { all: minecraft:block/stone }",
      "  elements [",
      "    {",
      "      from: [0, 0, 0]",
      "      to: [16, 16, 16]",
      "      rotation: { origin: [8, 8, 8], axis: y, angle: 45, rescale: true }",
      "      shade: true",
      "      light_emission: 0",
      "      faces: { north: { uv: [0, 0, 16, 16], texture: \"#all\", cullface: north, rotation: 90, tintindex: -1 } }",
      "    }",
      "  ]",
      "}",
    ].join("\n")));
    const validCodes = valid.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementVector"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelElementCoordinateOutOfRange"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceTexture"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelFaceRotation"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelDisplayContext"), false);
    assert.strictEqual(validCodes.includes("rsgl.invalidModelElementRotationAxis"), false);
    assert.strictEqual(validCodes.includes("rsgl.modelFaceUvOutOfRange"), false);

    const invalid = compileRsglModule(parseRsgl([
      "model block broken_geometry {",
      "  display {",
      "    bad_context: { rotation: [0, 0, 0] }",
      "    gui: { rotation: [0, 0], translation: [0, 81, 0], scale: [1, 5, 1] }",
      "    ground: \"bad\"",
      "  }",
      "  textures { all: minecraft:block/stone }",
      "  elements [",
      "    {",
      "      from: [-17, 0, 0]",
      "      to: [16, 33, 16]",
      "      rotation: { origin: [8, 8], axis: q, angle: \"bad\", rescale: \"yes\" }",
      "      shade: \"yes\"",
      "      light_emission: 16",
      "      faces: {",
      "        north: { texture: minecraft:block/stone, rotation: 45, uv: [0, 0, 17, 16], cullface: \"bad\", tintindex: -2 },",
      "        south: { texture: \"#all\", uv: [0, 0, \"bad\"] },",
      "        top: { texture: \"#all\" }",
      "      }",
      "    }",
      "    {",
      "      from: [0, 0]",
      "      to: [0, 0, \"bad\"]",
      "      faces: { south: { texture: \"#all\", rotation: 270 } }",
      "    }",
      "  ]",
      "}",
    ].join("\n")));
    const invalidCodes = invalid.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(invalidCodes.includes("rsgl.invalidModelElementVector"));
    assert.ok(invalidCodes.includes("rsgl.modelElementCoordinateOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceTexture"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceRotation"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayContext"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayTransform"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelDisplayVector"));
    assert.ok(invalidCodes.includes("rsgl.modelDisplayTranslationOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.modelDisplayScaleOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationOrigin"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationAxis"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRotationAngle"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementRescale"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementShade"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelElementLightEmission"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceName"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceUv"));
    assert.ok(invalidCodes.includes("rsgl.modelFaceUvOutOfRange"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceCullface"));
    assert.ok(invalidCodes.includes("rsgl.invalidModelFaceTintIndex"));
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
      "item empty_range_entries {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:count,",
      "      entries: []",
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
      "}",
      "item broken_condition {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:using_item,",
      "      on_true: { type: minecraft:model, model: minecraft:item/missing_true }",
      "    }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => false
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.unsortedItemRangeThresholds"));
    assert.ok(codes.includes("rsgl.emptyItemRangeEntries"));
    assert.ok(codes.includes("rsgl.itemModelMissingFallback"));
    assert.ok(codes.includes("rsgl.invalidItemSelectCase"));
    assert.ok(codes.includes("rsgl.invalidItemConditionBranch"));
  });

  it("validates item composite and terminal model types", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "item composite_with_missing_child {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:composite,",
      "      models: [",
      "        { type: minecraft:model, model: minecraft:item/missing_child },",
      "        { type: minecraft:empty },",
      "        { type: minecraft:bundle/selected_item }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item invalid_composite_models {",
      "  raw_json {",
      "    model: { type: minecraft:composite, models: \"bad\" }",
      "  }",
      "}",
      "item invalid_composite_child {",
      "  raw_json {",
      "    model: { type: minecraft:composite, models: [1] }",
      "  }",
      "}",
      "item unknown_model_type {",
      "  raw_json {",
      "    model: { type: minecraft:unknown }",
      "  }",
      "}",
      "item invalid_model_reference {",
      "  raw_json {",
      "    model: { type: minecraft:model, model: 1 }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.invalidItemCompositeModels"));
    assert.ok(codes.includes("rsgl.invalidItemCompositeModel"));
    assert.ok(codes.includes("rsgl.invalidItemModelType"));
    assert.ok(codes.includes("rsgl.invalidItemModelReference"));
    assert.ok(checkedResources.includes("model:minecraft:item/missing_child"));
    const compositeUnit = result.units.find(unit => unit.outputPath.endsWith("composite_with_missing_child.json"));
    const missingChildRange = compositeUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/models/0/model")?.sourceRange;
    const missingChildDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.modelNotFound" && diagnostic.message.includes("missing_child")
    );
    assert.deepStrictEqual(missingChildDiagnostic?.range, missingChildRange);

    const emptyCompositeDiagnostics = validateResourceUnits([minimalItemUnit({
      model: { type: "minecraft:composite", models: [] }
    })]);
    assert.ok(emptyCompositeDiagnostics.some(diagnostic => diagnostic.code === "rsgl.emptyItemCompositeModels"));
  });

  it("validates item special model resources and shape", () => {
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "item broken_special {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/missing_base,",
      "      model: { type: minecraft:chest, texture: \"missing\" }",
      "    }",
      "  }",
      "}",
      "item invalid_special {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: 1, model: \"not_an_object\" }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialBase"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModel"));
    assert.ok(checkedResources.includes("model:minecraft:item/missing_base"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/chest/missing"));
  });

  it("validates item special subtype fields and tints", () => {
    const result = compileRsglModule(parseRsgl([
      "item invalid_special_fields {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:special,",
      "      base: minecraft:item/base,",
      "      model: { type: minecraft:chest, chest_type: middle, openness: 2 }",
      "    }",
      "  }",
      "}",
      "item unknown_special_type {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:unknown } }",
      "  }",
      "}",
      "item invalid_special_texture {",
      "  raw_json {",
      "    model: { type: minecraft:special, base: minecraft:item/base, model: { type: minecraft:chest, texture: 1 } }",
      "  }",
      "}",
      "item invalid_tints {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      tints: [",
      "        { type: minecraft:constant, value: [1, 0.5] },",
      "        { type: minecraft:constant, value: -1 },",
      "        { type: minecraft:constant, value: 16777216 },",
      "        { type: minecraft:grass, temperature: 2 },",
      "        { type: minecraft:custom_model_data, default: 1, index: -1 },",
      "        { type: minecraft:unknown }",
      "      ]",
      "    }",
      "  }",
      "}",
      "item invalid_nested_tints {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{",
      "        when: \"left\",",
      "        model: {",
      "          type: minecraft:model,",
      "          model: minecraft:item/base,",
      "          tints: [{ type: minecraft:constant, value: [1, 2, 0] }]",
      "        }",
      "      }],",
      "      fallback: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.missingItemSpecialModelField"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModelField"));
    assert.ok(codes.includes("rsgl.invalidItemSpecialModelType"));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidItemSpecialModelField" && diagnostic.message.includes("'texture'")));
    assert.ok(codes.includes("rsgl.invalidItemTintColor"));
    assert.ok(codes.includes("rsgl.missingItemTintField"));
    assert.ok(codes.includes("rsgl.invalidItemTintField"));
    assert.ok(codes.includes("rsgl.invalidItemTint"));
    const invalidTintsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_tints.json"));
    const tintValueRange = invalidTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/tints/0/value")?.sourceRange;
    const invalidTintColor = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.invalidItemTintColor");
    assert.deepStrictEqual(invalidTintColor?.range, tintValueRange);
    assert.notDeepStrictEqual(invalidTintColor?.range, invalidTintsUnit?.sourceMap.mappings[0].sourceRange);
    const invalidNestedTintsUnit = result.units.find(unit => unit.outputPath.endsWith("invalid_nested_tints.json"));
    const nestedTintValueRange = invalidNestedTintsUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/model/cases/0/model/tints/0/value")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidItemTintColor"
      && diagnostic.range.start === nestedTintValueRange?.start
      && diagnostic.range.end === nestedTintValueRange?.end
    ));
  });

  it("validates item top-level fields and transformations", () => {
    const result = compileRsglModule(parseRsgl([
      "item invalid_top_level {",
      "  raw_json {",
      "    hand_animation_on_swap: \"yes\",",
      "    oversized_in_gui: 1,",
      "    swap_animation_scale: \"large\",",
      "    model: { type: minecraft:model, model: minecraft:item/base }",
      "  }",
      "}",
      "item invalid_matrix {",
      "  raw_json {",
      "    model: { type: minecraft:model, model: minecraft:item/base, transformation: [1, 0, 0] }",
      "  }",
      "}",
      "item invalid_transform_object {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:model,",
      "      model: minecraft:item/base,",
      "      transformation: {",
      "        left_rotation: { angle: 45, axis: [0, 1] },",
      "        scale: [1, 1, 1],",
      "        translation: [0, 0, \"bad\"]",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidItemTopLevelField"));
    assert.ok(codes.includes("rsgl.invalidItemTransformation"));
    assert.ok(codes.includes("rsgl.missingItemTransformationField"));
  });

  it("validates item property-specific fields", () => {
    const result = compileRsglModule(parseRsgl([
      "item invalid_range_property {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:range_dispatch,",
      "      property: minecraft:time,",
      "      source: day_time,",
      "      period: 0,",
      "      wobble: \"yes\",",
      "      entries: [{ threshold: 0, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_select_property {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:block_state,",
      "      component: 1,",
      "      cases: [{ when: stone, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_main_hand_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:main_hand,",
      "      cases: [{ when: \"middle\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_charge_type_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:charge_type,",
      "      cases: [{ when: [\"arrow\", \"bad\"], model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_display_context_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:display_context,",
      "      cases: [{ when: \"sideways\", model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_resource_id_when {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:select,",
      "      property: minecraft:potion_contents,",
      "      cases: [{ when: 1, model: { type: minecraft:model, model: minecraft:item/base } }]",
      "    }",
      "  }",
      "}",
      "item invalid_condition_property {",
      "  raw_json {",
      "    model: {",
      "      type: minecraft:condition,",
      "      property: minecraft:component,",
      "      predicate: 1,",
      "      on_true: { type: minecraft:model, model: minecraft:item/base },",
      "      on_false: { type: minecraft:model, model: minecraft:item/base }",
      "    }",
      "  }",
      "}",
      "item unknown_property {",
      "  raw_json {",
      "    model: { type: minecraft:select, property: minecraft:unknown, cases: [] }",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.missingItemPropertyField"));
    assert.ok(codes.includes("rsgl.invalidItemPropertyField"));
    assert.ok(codes.includes("rsgl.invalidItemProperty"));
    assert.ok(codes.includes("rsgl.invalidItemSelectWhenValue"));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidItemSelectWhenValue" && diagnostic.message.includes("resource ids")));
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

  it("validates external model parent chains and texture variables", () => {
    const checkedResources: string[] = [];
    const loadedModels: string[] = [];
    const externalModels = new Map<string, JsonValue>([
      ["minecraft:block/external_child", {
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }],
      ["minecraft:block/external_root", {
        textures: { root: "minecraft:block/external_texture" }
      }],
      ["minecraft:block/external_cycle_a", {
        parent: "minecraft:block/external_cycle_b"
      }],
      ["minecraft:block/external_cycle_b", {
        parent: "minecraft:block/external_cycle_a"
      }],
      ["minecraft:block/external_missing_child", {
        parent: "minecraft:block/external_missing_parent"
      }]
    ]);
    const result = compileRsglModule(parseRsgl([
      "model block child_external {",
      "  parent minecraft:block/external_child",
      "  textures { all: \"#alias\" }",
      "}",
      "model block cycle_external { parent minecraft:block/external_cycle_a }",
      "model block missing_external { parent minecraft:block/external_missing_child }"
    ].join("\n")), {
      resourceContent: (kind, id) => {
        assert.strictEqual(kind, "model");
        loadedModels.push(id);
        return externalModels.get(id);
      },
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return !(kind === "model" && id === "minecraft:block/external_missing_parent");
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(loadedModels.includes("minecraft:block/external_child"));
    assert.ok(loadedModels.includes("minecraft:block/external_root"));
    assert.ok(loadedModels.includes("minecraft:block/external_cycle_a"));
    assert.ok(loadedModels.includes("minecraft:block/external_cycle_b"));
    assert.ok(checkedResources.includes("texture:minecraft:block/external_texture"));
    assert.ok(checkedResources.includes("model:minecraft:block/external_missing_parent"));
    assert.ok(codes.includes("rsgl.modelParentCycle"));
    assert.ok(codes.includes("rsgl.modelNotFound"));
    assert.strictEqual(codes.includes("rsgl.unresolvedTextureVariable"), false);
  });

  it("uses workspace resource cache for RSGL validation resources", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const mainFile = path.join(packRoot, "main.rsgl");
    const externalChild = path.join(packRoot, "assets", "minecraft", "models", "block", "external_child.json");
    const externalRoot = path.join(packRoot, "assets", "minecraft", "models", "block", "external_root.json");
    const texture = path.join(packRoot, "assets", "minecraft", "textures", "block", "external_texture.png");
    const vertexShader = path.join(packRoot, "assets", "minecraft", "shaders", "core", "screenquad.vsh");
    const fragmentShader = path.join(packRoot, "assets", "minecraft", "shaders", "post", "box_blur.fsh");
    const effectTexture = path.join(packRoot, "assets", "minecraft", "textures", "effect", "blur", "mask.png");

    try {
      fs.mkdirSync(path.dirname(externalChild), { recursive: true });
      fs.mkdirSync(path.dirname(texture), { recursive: true });
      fs.mkdirSync(path.dirname(vertexShader), { recursive: true });
      fs.mkdirSync(path.dirname(fragmentShader), { recursive: true });
      fs.mkdirSync(path.dirname(effectTexture), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(mainFile, [
        "model block workspace_child {",
        "  parent minecraft:block/external_child",
        "  textures { all: \"#alias\" }",
        "}",
        "post_effect workspace_shader {",
        "  targets { swap: {} }",
        "  passes [",
        "    { vertex_shader: minecraft:core/screenquad, fragment_shader: minecraft:post/box_blur, inputs: [{ sampler_name: \"Mask\", location: minecraft:blur/mask }], output: \"swap\" }",
        "  ]",
        "}"
      ].join("\n"));
      fs.writeFileSync(externalChild, JSON.stringify({
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }));
      fs.writeFileSync(externalRoot, JSON.stringify({
        textures: { root: "minecraft:block/external_texture" }
      }));
      fs.writeFileSync(texture, Buffer.alloc(0));
      fs.writeFileSync(vertexShader, "");
      fs.writeFileSync(fragmentShader, "");
      fs.writeFileSync(effectTexture, Buffer.alloc(0));

      const cache = new WorkspaceResourceCache();
      const result = compileRsglFile(mainFile, createRsglWorkspaceValidationOptions({
        sourceFileName: mainFile,
        defaultAssetsPath: null,
        resourcePackRoots: [],
        cache
      }));
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.strictEqual(codes.includes("rsgl.modelNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.textureNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.vertexShaderNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.fragmentShaderNotFound"), false);
      assert.strictEqual(codes.includes("rsgl.unresolvedTextureVariable"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      "  pack { description: \"Generated\" }",
      "  overlays {",
      "    entries: [",
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

  it("validates mcmeta animation frames against texture metadata", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/block/animated.png\" {",
      "  animation {",
      "    width 16",
      "    height 16",
      "    frametime 0",
      "    interpolate \"yes\"",
      "    frames [0, 4, { index: 2, time: 0 }, { index: -1 }]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      textureMetadata: id => id === "minecraft:block/animated" ? { width: 16, height: 48 } : null
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidMcmetaFrameTime"));
    assert.ok(codes.includes("rsgl.invalidMcmetaInterpolate"));
    assert.ok(codes.includes("rsgl.invalidMcmetaFrameIndex"));
    assert.ok(codes.includes("rsgl.mcmetaFrameIndexOutOfRange"));
    assert.strictEqual(codes.includes("rsgl.invalidMcmetaFrameStrip"), false);
  });

  it("validates mcmeta animation frame strip dimensions", () => {
    const result = compileRsglModule(parseRsgl([
      "mcmeta \"assets/minecraft/textures/block/bad_strip.png\" {",
      "  animation {",
      "    frames [0]",
      "  }",
      "}"
    ].join("\n")), {
      resourceExists: () => true,
      textureMetadata: id => id === "minecraft:block/bad_strip" ? { width: 16, height: 20 } : null
    });

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidMcmetaFrameStrip"));
  });

  it("reads mcmeta texture metadata through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const textureFile = path.join(packRoot, "assets", "minecraft", "textures", "block", "adapter_bad_strip.png");
    try {
      fs.mkdirSync(path.dirname(textureFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(textureFile, createPngBytes(16, 20));
      fs.writeFileSync(sourceFile, [
        "mcmeta \"assets/minecraft/textures/block/adapter_bad_strip.png\" {",
        "  animation { frames [0] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: [],
        cache: new WorkspaceResourceCache()
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidMcmetaFrameStrip"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads sound metadata through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const soundFile = path.join(packRoot, "assets", "minecraft", "sounds", "entity", "example", "bad.ogg");
    try {
      fs.mkdirSync(path.dirname(soundFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(soundFile, Buffer.from("not ogg"));
      fs.writeFileSync(sourceFile, [
        "sounds minecraft {",
        "  \"entity.example.bad\" { sounds: [\"entity/example/bad\"] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: [],
        cache: new WorkspaceResourceCache()
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidSoundMetadata"));
      assert.strictEqual(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.soundNotFound"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("infers blockstate schemas through the workspace validation adapter", () => {
    const root = createTempDir();
    const packRoot = path.join(root, "pack");
    const sourceFile = path.join(packRoot, "main.rsgl");
    const blockstateFile = path.join(packRoot, "assets", "minecraft", "blockstates", "lamp.json");
    try {
      fs.mkdirSync(path.dirname(blockstateFile), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(blockstateFile, JSON.stringify({
        variants: {
          ["facing=north,lit=true"]: { model: "minecraft:block/lamp" },
          ["facing=south,lit=false"]: { model: "minecraft:block/lamp" }
        }
      }));
      fs.writeFileSync(sourceFile, [
        "blockstate lamp {",
        "  variants {",
        "    [facing=up lit=true extra=true] -> { model: minecraft:block/lamp }",
        "  }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: [],
        cache: new WorkspaceResourceCache()
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue"));
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unknownBlockstateStateProperty"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-"));
}

function emittedContent(file: RsglEmittedFile | undefined): string {
  if (!file || !("content" in file)) {
    throw new Error("Expected emitted content file.");
  }
  return file.content;
}

function minimalItemUnit(content: Record<string, JsonValue>): ResourceUnit {
  return {
    id: { namespace: "minecraft", path: "test_item" },
    kind: "item",
    outputPath: "assets/minecraft/items/test_item.json",
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: {
      generatedFile: "assets/minecraft/items/test_item.json",
      mappings: [{
        generatedPath: "",
        sourceFile: "test.rsgl",
        sourceRange: { start: 0, end: 1 },
        reason: "direct",
        expansionStack: []
      }]
    }
  };
}

function createPngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
