import * as assert from "node:assert/strict";
import {
  isMinecraftResourceLocationText,
  isValidMinecraftNamespace,
  minecraftResourceIdInFolder,
  minecraftResourceOutputPath,
  parseMinecraftResourceId,
  qualifyMinecraftResourceId,
  tryParseMinecraftResourceId
} from "../../src";

describe("minecraft resource primitives", () => {
  it("parses explicit and implicit resource ids with shared normalization", () => {
    assert.deepStrictEqual(parseMinecraftResourceId("example:block//stone"), {
      namespace: "example",
      path: "block/stone",
      hasExplicitNamespace: true,
      isValid: true
    });

    assert.deepStrictEqual(parseMinecraftResourceId("item/generated"), {
      namespace: "minecraft",
      path: "item/generated",
      hasExplicitNamespace: false,
      isValid: true
    });
  });

  it("rejects namespace and path values outside Minecraft resource rules", () => {
    assert.strictEqual(isValidMinecraftNamespace("Example"), false);
    assert.strictEqual(tryParseMinecraftResourceId("example:block/Stone"), null);
    assert.strictEqual(tryParseMinecraftResourceId("example:block:name"), null);
    assert.strictEqual(tryParseMinecraftResourceId("example:../outside"), null);
  });

  it("formats qualified ids and typed resource output paths", () => {
    assert.strictEqual(qualifyMinecraftResourceId("block/stone", "example"), "example:block/stone");
    assert.strictEqual(minecraftResourceIdInFolder("signal/big_smoke_0", "minecraft", "particle"), "minecraft:particle/signal/big_smoke_0");
    assert.strictEqual(
      minecraftResourceOutputPath("model", { namespace: "example", path: "block/stone" }),
      "assets/example/models/block/stone.json"
    );
  });

  it("identifies lexer-ready resource location text", () => {
    assert.strictEqual(isMinecraftResourceLocationText("minecraft:block/stone"), true);
    assert.strictEqual(isMinecraftResourceLocationText("block/stone"), false);
    assert.strictEqual(isMinecraftResourceLocationText("Example:block/stone"), false);
  });
});
