import * as assert from "assert";
import * as path from "node:path";
import { getPackMcmeta, isPackFormatVersion } from "../../commands/constants";
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

  it("serializes modern pack.mcmeta metadata safely", () => {
    const result = JSON.parse(getPackMcmeta("86.2", 'quote " and slash \\'));

    assert.deepStrictEqual(result.pack.min_format, [86, 2]);
    assert.deepStrictEqual(result.pack.max_format, [86, 2]);
    assert.strictEqual(result.pack.description, 'quote " and slash \\');
  });

  it("accepts integer and decimal pack format inputs", () => {
    assert.strictEqual(isPackFormatVersion("69"), true);
    assert.strictEqual(isPackFormatVersion("86.2"), true);
    assert.strictEqual(isPackFormatVersion("0"), false);
    assert.strictEqual(isPackFormatVersion("86.x"), false);
  });
});
