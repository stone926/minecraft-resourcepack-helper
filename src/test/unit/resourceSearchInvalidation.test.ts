import * as assert from "node:assert";
import * as path from "node:path";
import {
  isResourceSearchInventoryPath,
  resourcePathChangeAffectsSearchInventory,
  resourceUniverseChangeAffectsSearchInventory
} from "../../services/resourceSearchInvalidation";

describe("resource search invalidation", () => {
  it("recognizes only physical resource kinds exposed by search", () => {
    const asset = (...segments: string[]) => path.join(
      "C:",
      "packs",
      "demo pack",
      "assets",
      "minecraft",
      ...segments
    );

    assert.strictEqual(isResourceSearchInventoryPath(
      asset("blockstates", "stone.json")
    ), true);
    assert.strictEqual(isResourceSearchInventoryPath(
      asset("models", "block", "stone.json")
    ), true);
    assert.strictEqual(isResourceSearchInventoryPath(
      asset("textures", "block", "stone.png")
    ), true);
    assert.strictEqual(isResourceSearchInventoryPath(
      asset("sounds", "block", "stone.ogg")
    ), false);
    assert.strictEqual(isResourceSearchInventoryPath(
      asset("shaders", "core", "rendertype.vsh")
    ), false);
    assert.strictEqual(isResourceSearchInventoryPath(
      path.join("C:", "packs", "demo pack", "pack.mcmeta")
    ), false);
  });

  it("invalidates physical membership only for structural changes", () => {
    const model = path.join(
      "C:",
      "pack",
      "assets",
      "demo",
      "models",
      "block",
      "stone.json"
    );

    assert.strictEqual(resourcePathChangeAffectsSearchInventory(model, "change"), false);
    assert.strictEqual(resourcePathChangeAffectsSearchInventory(model, "create"), true);
    assert.strictEqual(resourcePathChangeAffectsSearchInventory(model, "delete"), true);
  });

  it("uses generated events and provider removal, but not physical refresh churn", () => {
    assert.strictEqual(resourceUniverseChangeAffectsSearchInventory({
      kind: "replacement",
      projectId: "project",
      providerIds: ["physical"]
    }), false);
    assert.strictEqual(resourceUniverseChangeAffectsSearchInventory({
      kind: "replacement",
      projectId: "project",
      providerIds: ["physical", "rsgl"]
    }), true);
    assert.strictEqual(resourceUniverseChangeAffectsSearchInventory({
      kind: "removal",
      projectId: "project",
      providerIds: ["physical"]
    }), true);
  });
});
