import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile } from "../../src/compiler";
import {
  createRsglWorkspaceValidationOptions,
  RsglWorkspaceValidationCache,
  type RsglValidationFileSystem
} from "../../src/workspaceValidation";
import { compileSource } from "./helpers/compile";
import { createPngBytes } from "./helpers/fixtures";
import { createTempDir } from "./helpers/fs";

describe("RSGL workspace validation", () => {
  it("reuses watcher-trusted validation I/O until the changed path is invalidated", () => {
    const fileName = path.resolve("virtual-validation", "model.json");
    let exists = true;
    let value = 1;
    let existsCalls = 0;
    let readCalls = 0;
    let versionCalls = 0;
    const fileSystem: RsglValidationFileSystem = {
      exists: () => { existsCalls++; return exists; },
      isDirectory: () => false,
      readJson: () => { readCalls++; return { value }; },
      readPngMetadata: () => null,
      readOggMetadata: () => null,
      fileVersion: () => { versionCalls++; return `v${value}`; }
    };
    const cache = new RsglWorkspaceValidationCache({ fileSystem, watcherTrusted: true });

    assert.strictEqual(cache.exists(fileName), true);
    assert.strictEqual(cache.exists(fileName), true);
    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    assert.deepStrictEqual([existsCalls, versionCalls, readCalls], [1, 1, 1]);

    exists = false;
    value = 2;
    assert.strictEqual(cache.exists(fileName), true);
    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    cache.invalidatePath(fileName);
    assert.strictEqual(cache.exists(fileName), false);
    assert.deepStrictEqual(cache.readJson(fileName), { value: 2 });
    assert.deepStrictEqual([existsCalls, versionCalls, readCalls], [2, 2, 2]);
  });

  it("uses TTL/version verification without rereading unchanged validation content", () => {
    const fileName = path.resolve("virtual-validation", "blockstate.json");
    let now = 0;
    let value = 1;
    let versionCalls = 0;
    let readCalls = 0;
    const fileSystem: RsglValidationFileSystem = {
      exists: () => true,
      isDirectory: () => false,
      readJson: () => { readCalls++; return { value }; },
      readPngMetadata: () => null,
      readOggMetadata: () => null,
      fileVersion: () => { versionCalls++; return `v${value}`; }
    };
    const cache = new RsglWorkspaceValidationCache({
      fileSystem,
      verificationTtlMs: 100,
      clock: () => now
    });

    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    now = 50;
    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    assert.deepStrictEqual([versionCalls, readCalls], [1, 1]);

    now = 101;
    assert.deepStrictEqual(cache.readJson(fileName), { value: 1 });
    assert.deepStrictEqual([versionCalls, readCalls], [2, 1]);

    value = 2;
    now = 202;
    assert.deepStrictEqual(cache.readJson(fileName), { value: 2 });
    assert.deepStrictEqual([versionCalls, readCalls], [3, 2]);
  });

  it("lets a reused validation resolver observe a resource created after TTL", () => {
    const packRoot = path.resolve("virtual-validation", "pack");
    const sourceFileName = path.join(packRoot, "src", "main.rsgl");
    const textureFileName = path.join(
      packRoot,
      "assets",
      "minecraft",
      "textures",
      "block",
      "late.png"
    );
    const existing = new Set([path.join(packRoot, "pack.mcmeta")].map(fileName => path.normalize(fileName)));
    let now = 0;
    const fileSystem: RsglValidationFileSystem = {
      exists: fileName => existing.has(path.normalize(fileName)),
      isDirectory: () => false,
      readJson: () => null,
      readPngMetadata: () => null,
      readOggMetadata: () => null
    };
    const cache = new RsglWorkspaceValidationCache({
      fileSystem,
      verificationTtlMs: 100,
      clock: () => now
    });
    const validation = createRsglWorkspaceValidationOptions({ sourceFileName, cache });

    assert.strictEqual(validation.resourceExists("texture", "minecraft:block/late"), false);
    existing.add(path.normalize(textureFileName));
    now = 99;
    assert.strictEqual(validation.resourceExists("texture", "minecraft:block/late"), false);
    now = 100;
    assert.strictEqual(validation.resourceExists("texture", "minecraft:block/late"), true);
  });

  it("recovers from a missed delete event using the default verification TTL", () => {
    const fileName = path.resolve("virtual-validation", "missed-delete.json");
    let now = 0;
    let exists = true;
    const fileSystem: RsglValidationFileSystem = {
      exists: () => exists,
      isDirectory: () => false,
      readJson: () => null,
      readPngMetadata: () => null,
      readOggMetadata: () => null
    };
    const cache = new RsglWorkspaceValidationCache({ fileSystem, clock: () => now });

    assert.strictEqual(cache.exists(fileName), true);
    exists = false;
    now = 999;
    assert.strictEqual(cache.exists(fileName), true);
    now = 1_000;
    assert.strictEqual(cache.exists(fileName), false);
  });

  it("uses filesystem workspace validation for RSGL resources", () => {
    const root = createTempDir();
    const sourcePack = path.join(root, "source-pack");
    const customPack = path.join(root, "custom-pack");
    const mainFile = path.join(sourcePack, "main.rsgl");
    const externalChild = path.join(customPack, "assets", "minecraft", "models", "block", "external_child.json");
    const externalRoot = path.join(customPack, "assets", "minecraft", "models", "block", "external_root.json");
    const texture = path.join(customPack, "assets", "minecraft", "textures", "block", "external_texture.png");
    const vertexShader = path.join(customPack, "assets", "minecraft", "shaders", "core", "screenquad.vsh");
    const fragmentShader = path.join(customPack, "assets", "minecraft", "shaders", "post", "box_blur.fsh");
    const effectTexture = path.join(customPack, "assets", "minecraft", "textures", "effect", "blur", "mask.png");

    try {
      fs.mkdirSync(path.dirname(externalChild), { recursive: true });
      fs.mkdirSync(path.dirname(texture), { recursive: true });
      fs.mkdirSync(path.dirname(vertexShader), { recursive: true });
      fs.mkdirSync(path.dirname(fragmentShader), { recursive: true });
      fs.mkdirSync(path.dirname(effectTexture), { recursive: true });
      fs.mkdirSync(path.dirname(mainFile), { recursive: true });
      fs.writeFileSync(path.join(sourcePack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(customPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(mainFile, [
        "extern custom model minecraft:block/external_child",
        "extern custom shader_vertex minecraft:core/screenquad",
        "extern custom shader_fragment minecraft:post/box_blur",
        "extern custom texture minecraft:effect/blur/mask",
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

      const result = compileRsglFile(mainFile, createRsglWorkspaceValidationOptions({
        sourceFileName: mainFile,
        defaultAssetsPath: null,
        resourcePackRoots: [customPack]
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
    const result = compileSource([
      "extern custom sound custom:entity/example/*",
      "extern custom texture_directory minecraft:block/missing_directory",
      "extern custom texture minecraft:block/*, minecraft:particle/missing_particle, minecraft:entity/equipment/humanoid/missing_equipment",
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
    ], {
      targetPackFormat: { major: 88 },
      externResourceExists: (_source, kind, id) => {
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
    const atlasUnit = result.units.find(unit => unit.outputPath.endsWith("atlases/blocks.json"));
    const atlasRange = (generatedPath: string) => {
      let current = generatedPath;
      while (current) {
        const range = atlasUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === current)?.sourceRange;
        if (range) {
          return range;
        }
        const slash = current.lastIndexOf("/");
        current = slash > 0 ? current.slice(0, slash) : "";
      }
      return atlasUnit?.sourceMap.mappings.find(mapping => mapping.generatedPath === "")?.sourceRange;
    };
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureDirectoryNotFound"
      && diagnostic.message.includes("missing_directory")
      && diagnostic.range.start === atlasRange("/sources/0/source")?.start
      && diagnostic.range.end === atlasRange("/sources/0/source")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_single")
      && diagnostic.range.start === atlasRange("/sources/1/resource")?.start
      && diagnostic.range.end === atlasRange("/sources/1/resource")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_unstitch")
      && diagnostic.range.start === atlasRange("/sources/2/resource")?.start
      && diagnostic.range.end === atlasRange("/sources/2/resource")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidAtlasFilterPattern"
      && diagnostic.message.includes("namespace")
      && diagnostic.range.start === atlasRange("/sources/3/pattern/namespace")?.start
      && diagnostic.range.end === atlasRange("/sources/3/pattern/namespace")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidAtlasFilterPattern"
      && diagnostic.message.includes("path")
      && diagnostic.range.start === atlasRange("/sources/3/pattern/path")?.start
      && diagnostic.range.end === atlasRange("/sources/3/pattern/path")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_palette")
      && diagnostic.range.start === atlasRange("/sources/4/textures/0")?.start
      && diagnostic.range.end === atlasRange("/sources/4/textures/0")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_palette_key")
      && diagnostic.range.start === atlasRange("/sources/4/palette_key")?.start
      && diagnostic.range.end === atlasRange("/sources/4/palette_key")?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("missing_permutation")
      && diagnostic.range.start === atlasRange("/sources/4/permutations/red")?.start
      && diagnostic.range.end === atlasRange("/sources/4/permutations/red")?.end
    ));
  });

  it("validates mcmeta animation frames against texture metadata", () => {
    const result = compileSource([
      "mcmeta \"assets/minecraft/textures/block/animated.png\" {",
      "  animation {",
      "    width 16",
      "    height 16",
      "    frametime 0",
      "    interpolate \"yes\"",
      "    frames [0, 4, { index: 2, time: 0 }, { index: -1 }]",
      "  }",
      "}"
    ], {
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
    const result = compileSource([
      "mcmeta \"assets/minecraft/textures/block/bad_strip.png\" {",
      "  animation {",
      "    frames [0]",
      "  }",
      "}"
    ], {
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
      fs.writeFileSync(textureFile, Buffer.concat([
        createPngBytes(16, 20),
        Buffer.alloc(1024 * 1024, 0xab)
      ]));
      fs.writeFileSync(sourceFile, [
        "mcmeta \"assets/minecraft/textures/block/adapter_bad_strip.png\" {",
        "  animation { frames [0] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidMcmetaFrameStrip"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads sound metadata through the workspace validation adapter", () => {
    const root = createTempDir();
    const sourcePack = path.join(root, "source-pack");
    const defaultAssets = path.join(root, "default-assets");
    const sourceFile = path.join(sourcePack, "main.rsgl");
    const soundFile = path.join(defaultAssets, "assets", "minecraft", "sounds", "entity", "example", "bad.ogg");
    try {
      fs.mkdirSync(path.dirname(soundFile), { recursive: true });
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(sourcePack, "pack.mcmeta"), "{}");
      fs.writeFileSync(soundFile, Buffer.from("not ogg"));
      fs.writeFileSync(sourceFile, [
        "extern vanilla sound minecraft:entity/example/bad",
        "sounds minecraft {",
        "  \"entity.example.bad\" { sounds: [\"entity/example/bad\"] }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: defaultAssets,
        resourcePackRoots: []
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
        "blockstate variants lamp {",
        "  case { facing: up, lit: true, extra: true } => minecraft:block/lamp",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: null,
        resourcePackRoots: []
      }));

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidBlockstateStateSchemaValue"));
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unknownBlockstateStateProperty"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates extern custom and vanilla roots from the current source pack", () => {
    const root = createTempDir();
    const sourcePack = path.join(root, "当前 source pack");
    const customPack = path.join(root, "configured packs", "自定义 pack");
    const defaultAssets = path.join(root, "default assets 原版");
    const sourceFile = path.join(sourcePack, "main.rsgl");
    const currentTexture = path.join(sourcePack, "assets", "minecraft", "textures", "block", "current_only.png");
    const customTexture = path.join(customPack, "assets", "example", "textures", "item", "custom_only.png");
    const vanillaTexture = path.join(defaultAssets, "assets", "example", "textures", "item", "vanilla_only.png");

    try {
      for (const fileName of [sourceFile, currentTexture, customTexture, vanillaTexture]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, fileName.endsWith(".png") ? createPngBytes(16, 16) : "");
      }
      for (const packRoot of [sourcePack, customPack]) {
        fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      }

      const validation = createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: defaultAssets,
        resourcePackRoots: [sourcePack, customPack]
      });

      assert.strictEqual(validation.resourceExists?.("texture", "minecraft:block/current_only"), true);
      assert.strictEqual(validation.externResourceExists("custom", "texture", "minecraft:block/current_only"), false);
      assert.strictEqual(validation.externResourceExists("vanilla", "texture", "minecraft:block/current_only"), false);
      assert.strictEqual(validation.externResourceExists("custom", "texture", "example:item/custom_only"), true);
      assert.strictEqual(validation.externResourceExists("vanilla", "texture", "example:item/custom_only"), false);
      assert.strictEqual(validation.externResourceExists("vanilla", "texture", "example:item/vanilla_only"), true);
      assert.strictEqual(validation.externResourceExists("custom", "texture", "example:item/vanilla_only"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves configured pack load order, overlays, filters, namespaces, and extern metadata", () => {
    const root = createTempDir();
    const sourcePack = path.join(root, "source pack");
    const highPack = path.join(root, "高优先级 pack");
    const lowPack = path.join(root, "low priority pack");
    const defaultAssets = path.join(root, "vanilla assets");
    const sourceFile = path.join(sourcePack, "main.rsgl");
    const modelRelative = path.join("assets", "example", "models", "block", "shared.json");
    const customTexture = path.join(highPack, "assets", "example", "textures", "block", "metadata.png");
    const vanillaTexture = path.join(defaultAssets, "assets", "example", "textures", "block", "metadata.png");
    const customSound = path.join(lowPack, "assets", "second", "sounds", "ambient", "invalid.ogg");
    const customBlockstate = path.join(lowPack, "assets", "second", "blockstates", "machine.json");
    const vanillaBlockstate = path.join(defaultAssets, "assets", "second", "blockstates", "machine.json");

    try {
      fs.mkdirSync(sourcePack, { recursive: true });
      fs.writeFileSync(sourceFile, "");
      fs.writeFileSync(path.join(sourcePack, "pack.mcmeta"), "{}");
      fs.mkdirSync(highPack, { recursive: true });
      fs.writeFileSync(path.join(highPack, "pack.mcmeta"), JSON.stringify({
        pack: {
          ["min_format"]: [88, 0],
          ["max_format"]: [88, 0],
          description: "test"
        },
        overlays: {
          entries: [{
            directory: "newer",
            ["min_format"]: [88, 0],
            ["max_format"]: [88, 0]
          }]
        },
        filter: {
          block: [{ namespace: "example", path: "models/block/blocked\\.json" }]
        }
      }));
      fs.mkdirSync(lowPack, { recursive: true });
      fs.writeFileSync(path.join(lowPack, "pack.mcmeta"), "{}");

      const jsonFiles: Array<[string, object]> = [
        [path.join(lowPack, modelRelative), { marker: "low" }],
        [path.join(highPack, modelRelative), { marker: "high-base" }],
        [path.join(highPack, "newer", modelRelative), { marker: "high-overlay" }],
        [path.join(defaultAssets, modelRelative), { marker: "vanilla" }],
        [path.join(lowPack, "assets", "example", "models", "block", "blocked.json"), { marker: "blocked" }],
        [path.join(lowPack, "assets", "second", "models", "block", "low_only.json"), { marker: "second-namespace" }],
        [customBlockstate, { variants: { ["facing=north"]: { model: "second:block/machine" } } }],
        [vanillaBlockstate, { variants: { ["powered=true"]: { model: "second:block/machine" } } }]
      ];
      for (const [fileName, content] of jsonFiles) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, JSON.stringify(content));
      }
      for (const [fileName, content] of [
        [customTexture, createPngBytes(7, 9)],
        [vanillaTexture, createPngBytes(11, 13)],
        [customSound, Buffer.from("not ogg")]
      ] as const) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, content);
      }

      const validation = createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        defaultAssetsPath: defaultAssets,
        resourcePackRoots: [highPack, lowPack]
      });

      assert.deepStrictEqual(
        validation.externResourceContent("custom", "model", "example:block/shared"),
        { marker: "high-overlay" }
      );
      assert.deepStrictEqual(
        validation.externResourceContent("vanilla", "model", "example:block/shared"),
        { marker: "vanilla" }
      );
      assert.strictEqual(validation.externResourceExists("custom", "model", "example:block/blocked"), false);
      assert.strictEqual(validation.externResourceExists("custom", "model", "second:block/low_only"), true);
      assert.deepStrictEqual(
        validation.externTextureMetadata("custom", "example:block/metadata"),
        { width: 7, height: 9 }
      );
      assert.deepStrictEqual(
        validation.externTextureMetadata("vanilla", "example:block/metadata"),
        { width: 11, height: 13 }
      );
      assert.strictEqual(validation.externSoundMetadata("custom", "second:ambient/invalid"), null);
      assert.strictEqual(validation.externSoundMetadata("vanilla", "second:ambient/invalid"), undefined);
      assert.deepStrictEqual(
        validation.externBlockstateSchema("custom", { namespace: "second", path: "machine" }),
        { properties: { facing: ["north"] } }
      );
      assert.deepStrictEqual(
        validation.externBlockstateSchema("vanilla", { namespace: "second", path: "machine" }),
        { properties: { powered: ["true"] } }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves bitmap texture ids that already include the png extension", () => {
    const root = createTempDir("rsgl-bitmap-texture-resolution-");
    const sourcePack = path.join(root, "source-pack");
    const customPack = path.join(root, "custom-pack");
    const sourceFile = path.join(sourcePack, "main.rsgl");
    const bitmap = path.join(customPack, "assets", "minecraft", "textures", "font", "ascii.png");

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.mkdirSync(path.dirname(bitmap), { recursive: true });
      fs.writeFileSync(sourceFile, "");
      fs.writeFileSync(path.join(sourcePack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(customPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(bitmap, createPngBytes(8, 8));

      const validation = createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        resourcePackRoots: [customPack]
      });

      assert.strictEqual(
        validation.externResourcePath("custom", "texture", "minecraft:font/ascii.png"),
        bitmap
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records missing external candidates and pack metadata for create invalidation", () => {
    const root = createTempDir("rsgl-missing-external-dependencies-");
    const sourcePack = path.join(root, "source-pack");
    const customPack = path.join(root, "custom-pack");
    const sourceFile = path.join(sourcePack, "src", "nested", "main.rsgl");
    const missingModel = path.join(
      customPack,
      "assets",
      "minecraft",
      "models",
      "block",
      "future.json"
    );
    const cache = new RsglWorkspaceValidationCache({ watcherTrusted: true });
    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.mkdirSync(customPack, { recursive: true });
      fs.writeFileSync(path.join(sourcePack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(customPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceFile, [
        "extern custom model minecraft:block/future",
        "model block child { parent minecraft:block/future }"
      ].join("\n"));
      const compile = () => compileRsglFile(sourceFile, createRsglWorkspaceValidationOptions({
        sourceFileName: sourceFile,
        resourcePackRoots: [customPack],
        cache
      }));

      const missing = compile();
      const dependencyPaths = missing.dependencies
        .filter(dependency => dependency.reason === "extern")
        .map(dependency => path.resolve(dependency.path));
      assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === "rsgl.modelNotFound"));
      assert.ok(dependencyPaths.includes(path.resolve(missingModel)));
      assert.ok(dependencyPaths.includes(path.join(sourcePack, "pack.mcmeta")));
      assert.ok(dependencyPaths.includes(path.join(sourcePack, "src", "pack.mcmeta")));
      assert.ok(dependencyPaths.includes(path.join(sourcePack, "src", "nested", "pack.mcmeta")));
      assert.ok(dependencyPaths.includes(path.join(customPack, "pack.mcmeta")));

      fs.mkdirSync(path.dirname(missingModel), { recursive: true });
      fs.writeFileSync(missingModel, "{}");
      assert.ok(compile().diagnostics.some(diagnostic => diagnostic.code === "rsgl.modelNotFound"));

      cache.invalidatePath(missingModel);
      assert.strictEqual(
        compile().diagnostics.some(diagnostic => diagnostic.code === "rsgl.modelNotFound"),
        false
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
