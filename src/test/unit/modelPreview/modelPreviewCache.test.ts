import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { ModelPreviewDocument } from "../../../modelPreview/ir/PreviewDocument";
import type { ResolvedModel } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewCache } from "../../../modelPreview/service/ModelPreviewCache";
import { WorkspaceResourceCache } from "../../../services/workspaceResourceCache";

const modelFileName = path.join("pack", "assets", "minecraft", "models", "block", "cached.json");
const parentFileName = path.join("pack", "assets", "minecraft", "models", "block", "parent.json");
const oldParentFileName = path.join("pack", "assets", "minecraft", "models", "block", "old_parent.json");
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

  it("does not let an invalidated preview completion mutate its replacement", async () => {
    const cache = new ModelPreviewCache();
    const stale = deferred<ModelPreviewDocument>();
    const staleCached = cache.set(modelFileName, stale.promise);
    cache.invalidate(modelFileName);

    const current = cache.set(modelFileName, Promise.resolve(createPreviewDocument([parentFileName])));
    await current;
    stale.resolve(createPreviewDocument([textureFileName]));
    await staleCached;

    cache.invalidateDependents(textureFileName);
    assert.strictEqual(cache.get(modelFileName), current, "stale dependencies must not replace current dependencies");
    cache.invalidateDependents(parentFileName);
    assert.strictEqual(cache.get(modelFileName), null);
  });

  it("keeps a replacement preview when an invalidated request rejects", async () => {
    const cache = new ModelPreviewCache();
    const stale = deferred<ModelPreviewDocument>();
    const staleCached = cache.set(modelFileName, stale.promise);
    cache.invalidate(modelFileName);
    const current = cache.set(modelFileName, Promise.resolve(createPreviewDocument([])));

    stale.reject(new Error("stale preview failed"));
    await assert.rejects(staleCached, /stale preview failed/);
    await current;
    assert.strictEqual(cache.get(modelFileName), current);
  });

  it("removes the current preview entry when its request rejects", async () => {
    const cache = new ModelPreviewCache();
    const rejected = cache.set(modelFileName, Promise.reject(new Error("preview failed")));

    await assert.rejects(rejected, /preview failed/);
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
    cache.setResolvedModel(
      modelFileName,
      "cfg",
      Promise.resolve(createResolvedModel([parentFileName])),
      versionsFor(modelFileName, parentFileName)
    );
    await cache.getResolvedModel(modelFileName, "cfg", () => "v1");

    assert.ok(cache.getResolvedModel(modelFileName, "cfg", () => "v1"));
    assert.strictEqual(cache.getResolvedModel(modelFileName, "other-cfg", () => "v1"), null);
    assert.strictEqual(cache.getResolvedModel(modelFileName, "cfg", () => "v2"), null, "changed dependency versions must force resolution");

    cache.invalidateDependents(parentFileName);
    assert.strictEqual(cache.getResolvedModel(modelFileName, "cfg", () => "v1"), null);
  });

  it("does not let stale resolved-model dependencies overwrite a replacement", async () => {
    const cache = new ModelPreviewCache();
    const stale = deferred<ResolvedModel>();
    cache.setResolvedModel(
      modelFileName,
      "cfg",
      stale.promise,
      versionsFor(modelFileName, oldParentFileName)
    );
    cache.invalidateDependents(modelFileName);
    cache.setResolvedModel(
      modelFileName,
      "cfg",
      Promise.resolve(createResolvedModel([parentFileName])),
      versionsFor(modelFileName, parentFileName)
    );
    await cache.getResolvedModel(modelFileName, "cfg", () => "v1");

    stale.resolve(createResolvedModel([oldParentFileName]));
    await stale.promise;
    cache.invalidateDependents(oldParentFileName);
    assert.ok(cache.getResolvedModel(modelFileName, "cfg", () => "v1"));
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
      cache.setResolvedModel(fileName, "cfg", Promise.resolve(createResolvedModel([])), versionsFor(fileName));
      cache.setTextureAlphaMask(texture, "v1", Promise.resolve(null));
    }

    assert.deepStrictEqual(cache.getStats(), {
      previews: 128,
      rawModels: 512,
      resolvedModels: 512,
      textureAlphaMasks: 512
    });
  });

  it("shares model and media artifacts through the workspace cache component", () => {
    const workspaceCache = new WorkspaceResourceCache();
    const first = new ModelPreviewCache(workspaceCache.modelPreviewArtifacts);
    const second = new ModelPreviewCache(workspaceCache.modelPreviewArtifacts);
    first.setRawModel(modelFileName, "v1", Promise.resolve({
      fileName: modelFileName,
      text: "{}",
      data: null
    }));
    first.setTextureAlphaMask(textureFileName, "v1", Promise.resolve(null));

    assert.ok(second.getRawModel(modelFileName, "v1"));
    assert.ok(second.getTextureAlphaMask(textureFileName, "v1"));
    assert.strictEqual(workspaceCache.getStats().sizes.rawModels, 1);
    assert.strictEqual(workspaceCache.getStats().sizes.textureAlphaMasks, 1);
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

function versionsFor(...fileNames: string[]): ReadonlyMap<string, string | null> {
  return new Map(fileNames.map(fileName => [fileName, "v1"]));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
