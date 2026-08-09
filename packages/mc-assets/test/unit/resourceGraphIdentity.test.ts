import * as assert from "node:assert/strict";
import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  normalizeResourceGraphFileSystemPath
} from "../../src/resourceGraphIdentity";
import { resourceGraphIdentityTestVectors } from "../shared/resourceGraphIdentityVectors";

describe("resource graph logical identity", () => {
  for (const vector of resourceGraphIdentityTestVectors) {
    it(vector.name, () => {
      assert.deepStrictEqual(
        canonicalizeResourceGraphIdentity(vector.kind, vector.value, vector.options),
        vector.expected
      );
    });
  }

  it("infers typed identities from slash and backslash output paths", () => {
    assert.deepStrictEqual(
      canonicalizeResourceGraphOutputPath(String.raw`overlay\assets\example\textures\block\stone.png`),
      canonicalizeResourceGraphIdentity("texture", "example:block/stone")
    );
    assert.deepStrictEqual(
      canonicalizeResourceGraphOutputPath("assets/example/shaders/post/blur.fsh"),
      canonicalizeResourceGraphIdentity("shaderFragment", "example:post/blur")
    );
  });

  it("keeps filesystem case policy separate from logical Minecraft validation", () => {
    const upper = String.raw`C:\Packs\Example\assets\minecraft\models\block\stone.json`;
    const lower = "c:/packs/example/assets/minecraft/models/block/stone.json";
    assert.notStrictEqual(
      normalizeResourceGraphFileSystemPath(upper),
      normalizeResourceGraphFileSystemPath(lower)
    );
    assert.strictEqual(
      normalizeResourceGraphFileSystemPath(upper, { caseSensitive: false }),
      normalizeResourceGraphFileSystemPath(lower, { caseSensitive: false })
    );
  });

  it("rejects paths that escape their normalization root", () => {
    assert.strictEqual(normalizeResourceGraphFileSystemPath("../assets/example/model.json"), null);
  });
});
