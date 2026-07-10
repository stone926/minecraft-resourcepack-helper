import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildRsglResourcePack,
  buildRsglResourcePackDirectory,
  buildRsglResourcePackProgram,
  prepareRsglResourcePackBuild,
  previewRsglResourcePackBuild,
  previewRsglResourcePackDirectoryBuild
} from "../../src/build";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";
import { createTempDir } from "./helpers/fs";

describe("RSGL build", () => {
  it("prepares emitted files without writing and honors cancellation after compilation", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const entry = path.join(root, "main.rsgl");
    const outputRoot = path.join(root, "pack");
    let cancellationChecks = 0;

    try {
      fs.writeFileSync(entry, [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));

      const prepared = prepareRsglResourcePackBuild(entry, {
        outputRoot,
        isCancellationRequested: () => {
          cancellationChecks++;
          return true;
        }
      });

      assert.ok(cancellationChecks > 0);
      assert.strictEqual(prepared.cancelled, true);
      assert.strictEqual(prepared.files, undefined);
      assert.strictEqual(fs.existsSync(outputRoot), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes emitted resources with source maps and a manifest", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const entry = path.join(root, "src", "main.rsgl");
    const outputRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));

      const result = buildRsglResourcePack(entry, { outputRoot });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.plan?.summary, { create: 3, update: 0, unchanged: 0 });
      assert.strictEqual(
        fs.existsSync(path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json")),
        true
      );
      assert.strictEqual(
        fs.existsSync(path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json.rsgl.map")),
        true
      );
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "rsgl.manifest.json")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write files when compilation has errors", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const entry = path.join(root, "main.rsgl");
    const outputRoot = path.join(root, "pack");

    try {
      fs.writeFileSync(entry, "use missingTemplate()");

      const result = buildRsglResourcePack(entry, { outputRoot });

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"));
      assert.strictEqual(result.plan, undefined);
      assert.strictEqual(fs.existsSync(outputRoot), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews planned changes without writing output files", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const entry = path.join(root, "src", "main.rsgl");
    const outputRoot = path.join(root, "pack");
    const modelPath = path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json");

    try {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));
      buildRsglResourcePack(entry, { outputRoot });
      const previousModel = fs.readFileSync(modelPath, "utf8");

      fs.writeFileSync(entry, [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/granite }",
        "}"
      ].join("\n"));
      const preview = previewRsglResourcePackBuild(entry, { outputRoot });

      assert.deepStrictEqual(preview.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(preview.plan?.summary, { create: 0, update: 2, unchanged: 1 });
      assert.ok(preview.preview?.includes("# RSGL Build Preview"));
      assert.ok(preview.preview?.includes("update: assets/minecraft/models/block/stone.json (+1 -1)"));
      assert.ok(preview.preview?.includes("update: assets/minecraft/models/block/stone.json.rsgl.map"));
      assert.ok(preview.preview?.includes("```diff"));
      assert.ok(preview.preview?.includes('-    "all": "minecraft:block/stone"'));
      assert.ok(preview.preview?.includes('+    "all": "minecraft:block/granite"'));
      assert.strictEqual(fs.readFileSync(modelPath, "utf8"), previousModel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews binary copy resources without writing output files", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const entry = path.join(root, "src", "main.rsgl");
    const outputRoot = path.join(root, "pack");
    const source = path.join(root, "src", "pack.png");

    try {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(source, Buffer.from([1, 2, 3]));
      fs.writeFileSync(entry, [
        "copy \"pack.png\" {",
        "  from \"pack.png\"",
        "}"
      ].join("\n"));

      const preview = previewRsglResourcePackBuild(entry, { outputRoot });

      assert.deepStrictEqual(preview.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(preview.plan?.summary, { create: 3, update: 0, unchanged: 0 });
      assert.ok(preview.preview?.includes("create: pack.png"));
      assert.ok(preview.preview?.includes(`Binary copy from ${source}`));
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "pack.png")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds every RSGL source file in a source directory", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const sourceRoot = path.join(root, "src");
    const outputRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "blocks.rsgl"), [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));
      fs.writeFileSync(path.join(sourceRoot, "items.rsgl"), [
        "model item stick {",
        "  parent minecraft:item/generated",
        "  textures { layer0: minecraft:item/stick }",
        "}"
      ].join("\n"));

      const result = buildRsglResourcePackDirectory(sourceRoot, { outputRoot });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.plan?.summary, { create: 5, update: 0, unchanged: 0 });
      assert.strictEqual(
        fs.existsSync(path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json")),
        true
      );
      assert.strictEqual(
        fs.existsSync(path.join(outputRoot, "assets", "minecraft", "models", "item", "stick.json")),
        true
      );
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "rsgl.manifest.json")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds from a pre-bound RSGL semantic program", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const sourceRoot = path.join(root, "src");
    const outputRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "blocks.rsgl"), [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));

      const semanticProgram = RsglWorkspaceSemanticCache.create().loadProgramFromDirectory(sourceRoot);
      const result = buildRsglResourcePackProgram(semanticProgram.files, {
        outputRoot,
        sourceRoot,
        semanticProgram: semanticProgram.program
      });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(result.plan?.summary, { create: 3, update: 0, unchanged: 0 });
      assert.strictEqual(
        fs.existsSync(path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json")),
        true
      );
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "rsgl.manifest.json")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews directory builds without writing output files", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const sourceRoot = path.join(root, "src");
    const outputRoot = path.join(root, "pack");
    const modelPath = path.join(outputRoot, "assets", "minecraft", "models", "block", "stone.json");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "blocks.rsgl"), [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/stone }",
        "}"
      ].join("\n"));
      buildRsglResourcePackDirectory(sourceRoot, { outputRoot });
      const previousModel = fs.readFileSync(modelPath, "utf8");

      fs.writeFileSync(path.join(sourceRoot, "blocks.rsgl"), [
        "model block stone {",
        "  parent minecraft:block/cube_all",
        "  textures { all: minecraft:block/deepslate }",
        "}"
      ].join("\n"));
      const preview = previewRsglResourcePackDirectoryBuild(sourceRoot, { outputRoot });

      assert.deepStrictEqual(preview.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.deepStrictEqual(preview.plan?.summary, { create: 0, update: 2, unchanged: 1 });
      assert.ok(preview.preview?.includes(`Source root: ${sourceRoot}`));
      assert.ok(preview.preview?.includes("update: assets/minecraft/models/block/stone.json (+1 -1)"));
      assert.ok(preview.preview?.includes('-    "all": "minecraft:block/stone"'));
      assert.ok(preview.preview?.includes('+    "all": "minecraft:block/deepslate"'));
      assert.strictEqual(fs.readFileSync(modelPath, "utf8"), previousModel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an error for an empty RSGL source directory", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-build-");
    const sourceRoot = path.join(root, "src");
    const outputRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });

      const result = buildRsglResourcePackDirectory(sourceRoot, { outputRoot });

      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), ["rsgl.compileMissingSource"]);
      assert.strictEqual(result.plan, undefined);
      assert.strictEqual(fs.existsSync(outputRoot), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
