import * as assert from "node:assert";
import * as path from "node:path";
import { getCitPathCandidates, getCitResourceType } from "../../utils/citPaths";

describe("OptiFine CIT path utilities", () => {
  const packRoot = path.join("workspace", "pack");
  const documentFileName = path.join(packRoot, "assets", "minecraft", "optifine", "cit", "swords", "diamond.properties");

  it("detects texture and model keys without matching unrelated keys", () => {
    assert.strictEqual(getCitResourceType("texture"), "textures");
    assert.strictEqual(getCitResourceType("texture.layer0"), "textures");
    assert.strictEqual(getCitResourceType("model"), "models");
    assert.strictEqual(getCitResourceType("model.bow_standby"), "models");
    assert.strictEqual(getCitResourceType("metadata"), null);
    assert.strictEqual(getCitResourceType("temperature"), null);
  });

  it("resolves local and default-namespace texture candidates", () => {
    assert.deepStrictEqual(
      getCitPathCandidates(documentFileName, packRoot, "diamond_sword", "textures"),
      [
        path.join(packRoot, "assets", "minecraft", "optifine", "cit", "swords", "diamond_sword.png"),
        path.join(packRoot, "assets", "minecraft", "textures", "diamond_sword.png")
      ]
    );
  });

  it("resolves namespaced model resource locations", () => {
    assert.deepStrictEqual(
      getCitPathCandidates(documentFileName, packRoot, "custom:item/diamond_sword", "models"),
      [
        path.join(packRoot, "assets", "custom", "models", "item", "diamond_sword.json")
      ]
    );
  });

  it("resolves explicit assets paths without changing the namespace", () => {
    assert.deepStrictEqual(
      getCitPathCandidates(documentFileName, packRoot, "assets/custom/textures/item/diamond_sword.png", "textures"),
      [
        path.join(packRoot, "assets", "custom", "textures", "item", "diamond_sword.png")
      ]
    );
  });
});
