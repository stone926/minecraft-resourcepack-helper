import * as assert from "assert";
import * as path from "node:path";
import { getPackMcmeta } from "../../commands/constants";
import { findAssetsRoot, parseResourceLocation } from "../../utils/resourceLocation";

describe("resource location utilities", () => {
  it("parses implicit minecraft namespace and appends extension", () => {
    const result = parseResourceLocation("block/acacia_button", "json");

    assert.strictEqual(result.namespace, "minecraft");
    assert.strictEqual(result.resourcePath, path.join("block", "acacia_button.json"));
  });

  it("parses explicit namespace without duplicating extension", () => {
    const result = parseResourceLocation("example:item/custom.png", "png");

    assert.strictEqual(result.namespace, "example");
    assert.strictEqual(result.resourcePath, path.join("item", "custom.png"));
  });

  it("parses directory resource locations without appending an extension", () => {
    const result = parseResourceLocation("minecraft:block", null);

    assert.strictEqual(result.namespace, "minecraft");
    assert.strictEqual(result.resourcePath, "block");
  });

  it("finds assets root from nested source folders", () => {
    const root = path.parse(__dirname).root;
    const fileName = path.join(root, "pack", "assets", "minecraft", "models", "block", "cube.json");
    const result = findAssetsRoot(fileName, "models/block");

    assert.strictEqual(result, path.join(root, "pack", "assets"));
  });

  it("finds assets root from namespace-root source files", () => {
    const root = path.parse(__dirname).root;
    const fileName = path.join(root, "pack", "assets", "minecraft", "sounds.json");
    const result = findAssetsRoot(fileName, "sounds.json");

    assert.strictEqual(result, path.join(root, "pack", "assets"));
  });

  it("serializes pack.mcmeta description safely", () => {
    const result = JSON.parse(getPackMcmeta("24", 'quote " and slash \\'));

    assert.strictEqual(result.pack.pack_format, 24);
    assert.strictEqual(result.pack.description, 'quote " and slash \\');
  });
});
