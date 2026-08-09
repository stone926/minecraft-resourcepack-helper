import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  getCitDocumentNamespace,
  getCitDocumentSource,
  getCitPathCandidates,
  isCitModelFileName,
  isCitPropertiesFileName
} from "../../cit/citPaths";

describe("CIT Resewn path utilities", () => {
  const packRoot = path.join("workspace", "pack");
  const documentFileName = path.join(packRoot, "assets", "minecraft", "citresewn", "cit", "swords", "diamond.properties");

  it("resolves local and default-namespace texture candidates", () => {
    assert.deepStrictEqual(
      getCitPathCandidates(documentFileName, packRoot, "diamond_sword", "textures"),
      [
        path.join(packRoot, "assets", "minecraft", "citresewn", "cit", "swords", "diamond_sword.png"),
        path.join(packRoot, "assets", "minecraft", "textures", "diamond_sword.png")
      ]
    );
  });

  it("resolves namespaced model resource locations", () => {
    assert.deepStrictEqual(
      getCitPathCandidates(documentFileName, packRoot, "custom:item/diamond_sword", "models"),
      [
        path.join(packRoot, "assets", "custom", "item", "diamond_sword.json"),
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

  it("resolves namespace-relative CIT asset paths in the document namespace", () => {
    const customDocument = path.join(packRoot, "assets", "custom", "citresewn", "cit", "stick.properties");

    assert.deepStrictEqual(
      getCitPathCandidates(customDocument, packRoot, "citresewn/cit/item_textures/stick", "textures"),
      [
        path.join(packRoot, "assets", "custom", "citresewn", "cit", "citresewn", "cit", "item_textures", "stick.png"),
        path.join(packRoot, "assets", "custom", "citresewn", "cit", "item_textures", "stick.png"),
        path.join(packRoot, "assets", "custom", "textures", "citresewn", "cit", "item_textures", "stick.png")
      ]
    );
  });

  it("detects CIT document namespace and source roots", () => {
    assert.strictEqual(isCitPropertiesFileName(documentFileName), true);
    assert.strictEqual(isCitPropertiesFileName(path.join(packRoot, "assets", "minecraft", "models", "item", "stick.properties")), false);
    assert.strictEqual(getCitDocumentNamespace(documentFileName), "minecraft");
    assert.strictEqual(getCitDocumentSource(documentFileName), ["citresewn", "cit", "swords"].join("/"));
  });

  it("does not treat legacy OptiFine or MCPatcher paths as CIT documents", () => {
    assert.strictEqual(
      isCitPropertiesFileName(path.join(packRoot, "assets", "minecraft", "optifine", "cit", "swords", "diamond.properties")),
      false
    );
    assert.strictEqual(
      isCitPropertiesFileName(path.join(packRoot, "assets", "minecraft", "mcpatcher", "cit", "swords", "diamond.properties")),
      false
    );
    assert.strictEqual(
      isCitModelFileName(path.join(packRoot, "assets", "minecraft", "optifine", "cit", "swords", "diamond.json")),
      false
    );
  });
});
