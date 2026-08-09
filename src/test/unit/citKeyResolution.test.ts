import * as assert from "node:assert/strict";
import {
  normalizeCitKey,
  resolveCitKey,
  resolveCitResourceType,
  resolveCitType
} from "../../cit/citKeyResolution";
import { citSpecService } from "../../cit/citSpecService";

describe("CIT key resolution", () => {
  it("normalizes the default namespace and resolves asset aliases from the spec", () => {
    const resolution = resolveCitKey(citSpecService.getCitSpec("item"), " citresewn:tile ");

    assert.strictEqual(normalizeCitKey(" citresewn:tile "), "tile");
    assert.strictEqual(resolution?.normalizedKey, "tile");
    assert.strictEqual(resolution?.canonicalKey, "texture");
    assert.strictEqual(resolution?.matchedBy, "alias");
    assert.strictEqual(resolution?.valueType, "asset");
    assert.strictEqual(resolution?.assetKind, "texture");
  });

  it("derives texture and model resource types from asset descriptors", () => {
    assert.strictEqual(resolveCitResourceType("tile"), "textures");
    assert.strictEqual(resolveCitResourceType("texture.layer0"), "textures");
    assert.strictEqual(resolveCitResourceType("model.bow_standby"), "models");
    assert.strictEqual(resolveCitResourceType("citresewn:texture"), "textures");
    assert.strictEqual(resolveCitResourceType("metadata"), null);
  });

  it("uses the normalized type key to select the effective CIT type", () => {
    assert.strictEqual(resolveCitType([{ key: "citresewn:type", value: "armor" }]), "armor");
    assert.strictEqual(resolveCitType([{ key: ":type", value: "elytra" }]), "elytra");
    assert.strictEqual(resolveCitType([{ key: "type", value: "unknown" }]), "item");
  });

  it("exposes runtime status from pattern descriptors", () => {
    const resolution = resolveCitKey(
      citSpecService.getCitSpec("item"),
      "citresewn:nbt.display.Name"
    );

    assert.strictEqual(resolution?.canonicalKey, "nbt.*");
    assert.strictEqual(resolution?.matchedBy, "pattern");
    assert.strictEqual(resolution?.runtimeStatus, "legacy");
    assert.ok(resolution?.runtimeNote);
  });
});
