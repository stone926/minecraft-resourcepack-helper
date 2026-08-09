import * as assert from "node:assert/strict";
import {
  canonicalMinecraftResourceKind,
  inferMinecraftResourceKindFromDirectory,
  isTextResourcePath,
  minecraftReferenceKindForResourceKind,
  minecraftResourceDirectory,
  minecraftResourceExtensionIconCategory,
  minecraftResourceKindIconCategory,
  minecraftResourceOutputPath,
  minecraftResourceTarget
} from "../../src";

describe("Minecraft resource targets", () => {
  it("canonicalizes supported snake-case aliases without changing canonical or unknown kinds", () => {
    assert.strictEqual(canonicalMinecraftResourceKind("texture_directory"), "textureDirectory");
    assert.strictEqual(canonicalMinecraftResourceKind("font_file"), "fontFile");
    assert.strictEqual(canonicalMinecraftResourceKind("shader_vertex"), "shaderVertex");
    assert.strictEqual(canonicalMinecraftResourceKind("shader_fragment"), "shaderFragment");
    assert.strictEqual(canonicalMinecraftResourceKind("textureDirectory"), "textureDirectory");
    assert.strictEqual(canonicalMinecraftResourceKind("custom_kind"), "custom_kind");
  });

  it("provides canonical forward targets and a predictable fallback for unknown kinds", () => {
    assert.deepStrictEqual(minecraftResourceTarget("model"), {
      directory: "models",
      extension: "json",
      isDirectory: false
    });
    assert.deepStrictEqual(minecraftResourceTarget("textureDirectory"), {
      directory: "textures",
      extension: null,
      isDirectory: true
    });
    assert.deepStrictEqual(minecraftResourceTarget("custom"), {
      directory: "custom",
      extension: "json",
      isDirectory: false
    });
    assert.strictEqual(minecraftResourceDirectory("blockstate"), "blockstates");
    assert.strictEqual(minecraftResourceDirectory("custom"), "custom");
  });

  it("infers unambiguous file kinds from assets directories and extensions", () => {
    assert.deepStrictEqual(inferMinecraftResourceKindFromDirectory("models", "block/cube.json"), {
      kind: "model",
      extension: "json"
    });
    assert.deepStrictEqual(inferMinecraftResourceKindFromDirectory("shaders", "core/rendertype.vsh"), {
      kind: "shaderVertex",
      extension: "vsh"
    });
    assert.deepStrictEqual(inferMinecraftResourceKindFromDirectory("shaders", "core/rendertype.fsh"), {
      kind: "shaderFragment",
      extension: "fsh"
    });
    assert.strictEqual(inferMinecraftResourceKindFromDirectory("textures", "block/stone.mcmeta"), null);
    assert.strictEqual(inferMinecraftResourceKindFromDirectory("unknown", "thing.json"), null);
  });

  it("collapses shader variants to their shared reference kind", () => {
    assert.strictEqual(minecraftReferenceKindForResourceKind("model"), "model");
    assert.strictEqual(minecraftReferenceKindForResourceKind("shaderVertex"), "shader");
    assert.strictEqual(minecraftReferenceKindForResourceKind("shaderFragment"), "shader");
    assert.strictEqual(minecraftReferenceKindForResourceKind("blockstate"), null);
    assert.strictEqual(minecraftReferenceKindForResourceKind("unknown"), null);
  });

  it("derives icon families from kinds and case-insensitive bare extensions", () => {
    assert.strictEqual(minecraftResourceKindIconCategory("model"), "code");
    assert.strictEqual(minecraftResourceKindIconCategory("texture"), "media");
    assert.strictEqual(minecraftResourceKindIconCategory("atlas"), "object");
    assert.strictEqual(minecraftResourceExtensionIconCategory("JSON"), "code");
    assert.strictEqual(minecraftResourceExtensionIconCategory("Png"), "media");
    assert.strictEqual(minecraftResourceExtensionIconCategory("mcmeta"), undefined);
  });

  it("builds portable assets output paths and recognizes text resource suffixes", () => {
    assert.strictEqual(
      minecraftResourceOutputPath("model", { namespace: "example", path: "block/machine" }),
      "assets/example/models/block/machine.json"
    );
    assert.strictEqual(
      minecraftResourceOutputPath("shaderVertex", { namespace: "example", path: "core/custom" }, "vsh"),
      "assets/example/shaders/core/custom.vsh"
    );
    assert.strictEqual(isTextResourcePath("assets/example/models/item/test.JSON"), true);
    assert.strictEqual(isTextResourcePath("assets/example/shaders/include/common.GLSL"), true);
    assert.strictEqual(isTextResourcePath("assets/example/textures/block/stone.png"), false);
    assert.strictEqual(isTextResourcePath("README"), false);
  });
});
