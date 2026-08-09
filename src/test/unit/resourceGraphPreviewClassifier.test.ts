import * as assert from "node:assert/strict";
import * as path from "node:path";
import { classifyResourceGraphPreview } from "../../views/resourceGraphPreviewClassifier";

describe("resource graph preview classifier", () => {
  it("classifies previewable and explicitly unsupported graph resources", () => {
    assert.strictEqual(
      classifyResourceGraphPreview(path.join("pack", "assets", "minecraft", "models", "block", "stone.json")),
      "modelResource"
    );
    assert.strictEqual(
      classifyResourceGraphPreview(path.join("pack", "assets", "minecraft", "citresewn", "stone.properties")),
      "citPreviewResource"
    );
    assert.strictEqual(
      classifyResourceGraphPreview(path.join("pack", "assets", "minecraft", "blockstates", "stone.json")),
      "unsupportedPreviewResource"
    );
    assert.strictEqual(
      classifyResourceGraphPreview(path.join("pack", "assets", "minecraft", "items", "stone.json")),
      "unsupportedPreviewResource"
    );
    assert.strictEqual(
      classifyResourceGraphPreview(path.join("pack", "assets", "minecraft", "font", "default.json")),
      undefined
    );
  });
});
