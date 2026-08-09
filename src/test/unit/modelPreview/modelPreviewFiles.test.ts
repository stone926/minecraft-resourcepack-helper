import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  isModelPreviewFileName,
  isPackMetadataFileName
} from "../../../modelPreview/host/modelPreviewFiles";

describe("model preview file predicates", () => {
  it("accepts model JSON only below an assets namespace models directory", () => {
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "assets", "example", "models", "block", "machine.json"
    )), true);
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "overlay_88", "assets", "example", "models", "item", "tool.JSON"
    )), true);
    assert.strictEqual(isModelPreviewFileName(path.join("pack", "models", "block", "machine.json")), false);
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "assets", "example", "models", "block", "machine.png"
    )), false);
  });

  it("accepts CIT Resewn properties documents and rejects unrelated properties", () => {
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "assets", "example", "citresewn", "cit", "custom.properties"
    )), true);
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "assets", "example", "citresewn", "nested", "custom.PROPERTIES"
    )), true);
    assert.strictEqual(isModelPreviewFileName(path.join(
      "pack", "assets", "example", "optifine", "cit", "custom.properties"
    )), false);
    assert.strictEqual(isModelPreviewFileName(path.join("pack", "custom.properties")), false);
  });

  it("recognizes only a pack.mcmeta basename across supported path separators", () => {
    assert.strictEqual(isPackMetadataFileName("pack.mcmeta"), true);
    assert.strictEqual(isPackMetadataFileName("C:\\packs\\example\\PACK.MCMETA"), true);
    assert.strictEqual(isPackMetadataFileName("/packs/example/pack.mcmeta"), true);
    assert.strictEqual(isPackMetadataFileName("/packs/example/not-pack.mcmeta"), false);
    assert.strictEqual(isPackMetadataFileName("/packs/example/pack.mcmeta.backup"), false);
  });
});
