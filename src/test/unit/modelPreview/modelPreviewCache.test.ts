import * as assert from "node:assert";
import * as path from "node:path";
import type { ModelPreviewDocument } from "../../../modelPreview/ir/PreviewDocument";
import type { ResolvedModel } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewCache } from "../../../modelPreview/service/ModelPreviewCache";

const modelFileName = path.join("pack", "assets", "minecraft", "models", "block", "cached.json");
const parentFileName = path.join("pack", "assets", "minecraft", "models", "block", "parent.json");
const textureFileName = path.join("pack", "assets", "minecraft", "textures", "block", "cached.png");

describe("model preview cache", () => {
  it("invalidates cached previews whose recorded dependencies change", async () => {
    const cache = new ModelPreviewCache();
    cache.set(modelFileName, Promise.resolve(createPreviewDocument([textureFileName])));
    await cache.get(modelFileName);

    cache.invalidateDependents(path.join("pack", "assets", "minecraft", "textures", "block", "other.png"));
    assert.ok(cache.get(modelFileName), "unrelated files must not evict the preview");

    cache.invalidateDependents(textureFileName);
    assert.strictEqual(cache.get(modelFileName), null);
  });

  it("guards preview entries by their own path before dependencies are recorded", () => {
    const cache = new ModelPreviewCache();
    cache.set(modelFileName, new Promise<ModelPreviewDocument>(() => { /* never resolves */ }));

    cache.invalidateDependents(modelFileName);

    assert.strictEqual(cache.get(modelFileName), null);
  });

  it("keeps versioned raw model and texture alpha entries only while the version matches", () => {
    const cache = new ModelPreviewCache();
    cache.setRawModel(modelFileName, "v1", Promise.resolve({ fileName: modelFileName, text: "{}", data: null }));
    cache.setTextureAlphaMask(textureFileName, "v1", Promise.resolve(null));

    assert.ok(cache.getRawModel(modelFileName, "v1"));
    assert.strictEqual(cache.getRawModel(modelFileName, "v2"), null);
    assert.ok(cache.getTextureAlphaMask(textureFileName, "v1"));
    assert.strictEqual(cache.getTextureAlphaMask(textureFileName, "v2"), null);

    cache.invalidateDependents(modelFileName);
    cache.invalidateDependents(textureFileName);

    assert.strictEqual(cache.getRawModel(modelFileName, "v1"), null);
    assert.strictEqual(cache.getTextureAlphaMask(textureFileName, "v1"), null);
  });

  it("revalidates resolved models against configuration key and dependency versions", async () => {
    const cache = new ModelPreviewCache();
    cache.setResolvedModel(modelFileName, "cfg", Promise.resolve(createResolvedModel([parentFileName])), () => "v1");
    await cache.getResolvedModel(modelFileName, "cfg", () => "v1");

    assert.ok(cache.getResolvedModel(modelFileName, "cfg", () => "v1"));
    assert.strictEqual(cache.getResolvedModel(modelFileName, "other-cfg", () => "v1"), null);
    assert.strictEqual(cache.getResolvedModel(modelFileName, "cfg", () => "v2"), null, "changed dependency versions must force resolution");

    cache.invalidateDependents(parentFileName);
    assert.strictEqual(cache.getResolvedModel(modelFileName, "cfg", () => "v1"), null);
  });

  it("scopes invalidate to one preview while invalidateAll clears every cache", async () => {
    const cache = new ModelPreviewCache();
    cache.set(modelFileName, Promise.resolve(createPreviewDocument([])));
    cache.setRawModel(modelFileName, "v1", Promise.resolve({ fileName: modelFileName, text: "{}", data: null }));
    await cache.get(modelFileName);

    cache.invalidate(modelFileName);

    assert.strictEqual(cache.get(modelFileName), null);
    assert.ok(cache.getRawModel(modelFileName, "v1"), "invalidate must keep reusable raw model entries");

    cache.invalidateAll();

    assert.strictEqual(cache.getRawModel(modelFileName, "v1"), null);
  });

  it("bounds preview cache sizes", () => {
    const cache = new ModelPreviewCache();

    for (let index = 0; index < 600; index++) {
      const fileName = path.join("pack", "assets", "minecraft", "models", "block", `model_${index}.json`);
      const texture = path.join("pack", "assets", "minecraft", "textures", "block", `texture_${index}.png`);
      cache.set(fileName, Promise.resolve(createPreviewDocument([])));
      cache.setRawModel(fileName, "v1", Promise.resolve({ fileName, text: "{}", data: null }));
      cache.setResolvedModel(fileName, "cfg", Promise.resolve(createResolvedModel([])), () => "v1");
      cache.setTextureAlphaMask(texture, "v1", Promise.resolve(null));
    }

    assert.deepStrictEqual(cache.getStats(), {
      previews: 128,
      rawModels: 512,
      resolvedModels: 512,
      textureAlphaMasks: 512
    });
  });
});

function createPreviewDocument(dependencyUris: string[]): ModelPreviewDocument {
  return {
    version: 1,
    sourceUri: modelFileName,
    resourceId: "minecraft:block/cached",
    title: "cached",
    bounds: { min: [0, 0, 0], max: [16, 16, 16] },
    meshes: [],
    materials: [],
    display: {},
    dependencies: dependencyUris.map(uri => ({ uri, kind: "texture" as const })),
    issues: []
  };
}

function createResolvedModel(dependencyFileNames: string[]): ResolvedModel {
  return {
    fileName: modelFileName,
    resourceId: "minecraft:block/cached",
    generatedItem: false,
    textures: {},
    elements: [],
    display: {},
    dependencies: dependencyFileNames.map(fileName => ({ fileName, kind: "model" as const }))
  };
}
