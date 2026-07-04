import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRsglResourcePack, previewRsglResourcePackBuild } from "../../rsgl/build";

describe("RSGL build", () => {
  it("writes emitted resources with source maps and a manifest", () => {
    const root = createTempDirectory();
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
    const root = createTempDirectory();
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
    const root = createTempDirectory();
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
});

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-build-"));
}
