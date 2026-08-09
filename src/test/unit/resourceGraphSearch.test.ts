import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  createIncomingReferenceSearch,
  getAssetResource,
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  isResourceJsonDocumentPath
} from "../../utils/resourceGraphSearch";

describe("resource graph search", () => {
  it("generates namespaced, JSON-escaped, and raw search values for texture assets", () => {
    const search = createIncomingReferenceSearch({
      scheme: "file",
      fsPath: path.join("pack", "assets", "minecraft", "textures", "block", "stone.png")
    });

    assert.ok(search);
    assert.ok(search.values.has("minecraft:block/stone"));
    assert.ok(search.values.has("\"minecraft:block/stone\""));
    assert.ok(search.values.has("assets/minecraft/textures/block/stone.png"));
    assert.ok(search.values.has("block/stone"));
    assert.ok(search.values.has("stone"));
  });

  it("generates model search values that match blockstate and JSON reference spellings", () => {
    const search = createIncomingReferenceSearch({
      scheme: "file",
      fsPath: path.join("pack", "assets", "minecraft", "models", "block", "cube.json")
    });

    assert.ok(search);
    assert.ok(search.values.has("\"minecraft:block/cube\""));
    assert.ok(search.values.has("\"block/cube\""));
    assert.ok(search.values.has(String.raw`"minecraft:block\/cube"`));
    assert.strictEqual(search.matchesText("{ \"variants\": { \"\": { \"model\": \"minecraft:block/cube\" } } }"), true);
    assert.strictEqual(search.matchesText("no reference in this text"), false);
    assert.strictEqual(search.matchesText("\"\\u0062lock/cube\""), true, "unicode escapes must stay conservative matches");
  });

  it("uses descriptor-provided layered equipment aliases", () => {
    const search = createIncomingReferenceSearch({
      scheme: "file",
      fsPath: path.join(
        "pack",
        "assets",
        "minecraft",
        "textures",
        "entity",
        "equipment",
        "humanoid",
        "diamond.png"
      )
    });

    assert.ok(search?.values.has("minecraft:diamond"));
    assert.ok(search?.values.has("diamond.png"));
  });

  it("returns null for non-file targets and paths outside an assets tree", () => {
    assert.strictEqual(createIncomingReferenceSearch({ scheme: "untitled", fsPath: "cube.json" }), null);
    assert.strictEqual(
      createIncomingReferenceSearch({ scheme: "file", fsPath: path.join("pack", "textures", "stone.png") }),
      null
    );
    assert.strictEqual(getAssetResource(path.join("pack", "assets", "minecraft")), null);
    assert.deepStrictEqual(
      getAssetResource(path.join("pack", "assets", "custom", "sounds", "ambient.ogg")),
      { namespace: "custom", resourcePath: "sounds/ambient.ogg" }
    );
  });

  it("classifies model, resource JSON, and resource graph document paths", () => {
    assert.strictEqual(isModelDocumentPath(path.join("pack", "assets", "minecraft", "models", "block", "cube.json")), true);
    assert.strictEqual(isModelDocumentPath(path.join("pack", "assets", "minecraft", "textures", "block", "stone.png")), false);
    assert.strictEqual(isResourceJsonDocumentPath(path.join("pack", "assets", "minecraft", "blockstates", "stone.json")), true);
    assert.strictEqual(isResourceJsonDocumentPath(path.join("pack", "data", "recipes", "stone.json")), false);
    assert.strictEqual(
      isResourceGraphDocumentPath(path.join("pack", "assets", "minecraft", "shaders", "include", "fog.glsl")),
      true
    );
    assert.strictEqual(isResourceGraphDocumentPath(path.join("pack", "README.md")), false);
  });
});
