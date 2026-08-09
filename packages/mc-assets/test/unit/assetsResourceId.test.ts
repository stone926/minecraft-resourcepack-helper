import * as assert from "node:assert/strict";
import * as path from "node:path";
import { inferMinecraftResourceIdFromAssetsFile } from "../../src";

describe("assets resource id inference", () => {
  it("removes an explicit resource-directory prefix", () => {
    const fileName = path.join(
      "pack",
      "assets",
      "example",
      "models",
      "item",
      "tools",
      "hammer.json"
    );

    assert.strictEqual(
      inferMinecraftResourceIdFromAssetsFile(fileName, { stripPathPrefixes: ["models"] }),
      "example:item/tools/hammer"
    );
  });

  it("can infer a namespace-qualified id from only the file name", () => {
    const fileName = path.join(
      "pack",
      "assets",
      "custom",
      "citresewn",
      "cit",
      "nested",
      "wand.properties"
    );

    assert.strictEqual(
      inferMinecraftResourceIdFromAssetsFile(fileName, { pathMode: "basename" }),
      "custom:wand"
    );
  });

  it("rejects missing required prefixes and invalid resource paths", () => {
    assert.strictEqual(
      inferMinecraftResourceIdFromAssetsFile(
        path.join("pack", "assets", "example", "textures", "item", "wand.png"),
        { stripPathPrefixes: ["models"], requirePathPrefix: true }
      ),
      null
    );
    assert.strictEqual(
      inferMinecraftResourceIdFromAssetsFile(
        path.join("pack", "assets", "example", "models", "item", "Bad Name.json"),
        { stripPathPrefixes: ["models"] }
      ),
      null
    );
  });
});
