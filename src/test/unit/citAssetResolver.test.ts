import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  citResourceTypeFor,
  getCitAssetCandidates,
  resolveCitAsset,
  resolveCitReferenceAsset
} from "../../cit/citAssetResolver";

describe("CIT asset resolver", () => {
  const packRoot = path.join("workspace", "pack");
  const sourceFileName = path.join(
    packRoot,
    "assets",
    "minecraft",
    "citresewn",
    "cit",
    "tools",
    "hammer.properties"
  );

  it("maps reference target and extension through one descriptor", () => {
    assert.strictEqual(citResourceTypeFor("textures", "png"), "textures");
    assert.strictEqual(citResourceTypeFor("models", "json"), "models");
    assert.strictEqual(citResourceTypeFor("textures", "json"), null);
  });

  it("resolves the first existing CIT candidate", () => {
    const candidates = getCitAssetCandidates(sourceFileName, "./hammer", "models", {
      pathExists: () => false,
      getPackRoot: () => packRoot
    });
    const expected = path.join(packRoot, "assets", "minecraft", "citresewn", "cit", "tools", "hammer.json");

    assert.strictEqual(candidates[0], expected);
    assert.strictEqual(resolveCitAsset(sourceFileName, "./hammer", "models", {
      pathExists: fileName => fileName === expected,
      getPackRoot: () => packRoot
    }), expected);
  });

  it("orders auto-discovered models before textures", () => {
    const candidates = getCitAssetCandidates(sourceFileName, "hammer", "auto", {
      pathExists: () => false,
      getPackRoot: () => packRoot
    });

    assert.ok(candidates[0].endsWith("hammer.json"));
    assert.ok(candidates.findIndex(candidate => candidate.endsWith("hammer.json")) <
      candidates.findIndex(candidate => candidate.endsWith("hammer.png")));
  });

  it("uses typed fallback only for portable resource paths", () => {
    let fallbackCalls = 0;
    const host = {
      pathExists: () => false,
      getPackRoot: () => packRoot,
      resolveTypedResource: () => {
        fallbackCalls++;
        return path.join(packRoot, "fallback.png");
      }
    };
    const reference = { value: "minecraft:item/hammer", target: "textures", extension: "png" };

    assert.strictEqual(resolveCitReferenceAsset(sourceFileName, reference, host), path.join(packRoot, "fallback.png"));
    assert.strictEqual(resolveCitReferenceAsset(sourceFileName, { ...reference, value: "./hammer" }, host), null);
    assert.strictEqual(resolveCitReferenceAsset(sourceFileName, { ...reference, value: "assets/minecraft/hammer" }, host), null);
    assert.strictEqual(fallbackCalls, 1);
  });
});
