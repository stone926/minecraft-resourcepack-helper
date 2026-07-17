import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceResourceCache } from "../../services/workspaceResourceCache";
import { createOggVorbisBytes, createPngBytes, createTempDirectory } from "./helpers/tempPack";

describe("workspace resource cache", () => {
  it("uses watcher generations for trusted hot-cache versions without stat calls", () => {
    let statCalls = 0;
    const cache = new WorkspaceResourceCache({
      stat: () => {
        statCalls++;
        return { mtimeMs: 1, size: 2 };
      }
    });
    const fileName = path.resolve("pack", "assets", "minecraft", "models", "block", "cube.json");
    cache.setWatcherTrustProvider(() => true);

    const first = cache.getFileVersion(fileName);
    const second = cache.getFileVersion(fileName);

    assert.strictEqual(first, second);
    assert.strictEqual(statCalls, 0);

    cache.invalidatePath(fileName);
    assert.notStrictEqual(cache.getFileVersion(fileName), first);
    assert.strictEqual(statCalls, 0);
  });

  it("revalidates untrusted file versions by TTL and mtime", () => {
    let now = 100;
    let statCalls = 0;
    let version = { mtimeMs: 1, size: 2 };
    const cache = new WorkspaceResourceCache({
      verificationTtlMs: 50,
      now: () => now,
      stat: () => {
        statCalls++;
        return version;
      }
    });
    cache.setWatcherTrustProvider(() => false);
    const fileName = path.resolve("external", "assets", "minecraft", "models", "block", "cube.json");

    assert.strictEqual(cache.getFileVersion(fileName), "1:2");
    now = 149;
    version = { mtimeMs: 3, size: 4 };
    assert.strictEqual(cache.getFileVersion(fileName), "1:2");
    assert.strictEqual(statCalls, 1);

    now = 150;
    assert.strictEqual(cache.getFileVersion(fileName), "3:4");
    assert.strictEqual(statCalls, 2);
  });

  it("revalidates untrusted directory inventories only after their TTL expires", () => {
    const root = createTempDirectory();
    let now = 0;
    let version = 1;
    try {
      const cache = new WorkspaceResourceCache({
        verificationTtlMs: 100,
        now: () => now,
        stat: () => ({ mtimeMs: version, size: version })
      });
      cache.setWatcherTrustProvider(() => false);
      assert.deepStrictEqual(cache.getDirectoryEntriesSync(root)?.map(entry => entry.name), []);

      fs.writeFileSync(path.join(root, "created.json"), "{}");
      version = 2;
      now = 99;
      assert.deepStrictEqual(cache.getDirectoryEntriesSync(root)?.map(entry => entry.name), []);

      now = 100;
      assert.deepStrictEqual(cache.getDirectoryEntriesSync(root)?.map(entry => entry.name), ["created.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries untrusted negative resource resolutions after verification TTL", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");
    const sourceModel = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
    const texturePath = path.join(packRoot, "assets", "minecraft", "textures", "block", "late.png");
    let now = 0;
    try {
      fs.mkdirSync(path.dirname(sourceModel), { recursive: true });
      fs.mkdirSync(path.dirname(texturePath), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceModel, "{}");
      const cache = new WorkspaceResourceCache({ verificationTtlMs: 100, now: () => now });
      cache.setWatcherTrustProvider(() => false);
      const request = {
        resourcePath: "minecraft:block/late",
        sourceFileName: sourceModel,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: []
      };

      assert.strictEqual(cache.resolveResourcePath(request), null);
      fs.writeFileSync(texturePath, createPngBytes(16, 16));
      now = 99;
      assert.strictEqual(cache.resolveResourcePath(request), null);
      now = 100;
      assert.strictEqual(cache.resolveResourcePath(request), texturePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries untrusted pack-root discovery after verification TTL", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "late-pack");
    const sourceFile = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
    let now = 0;
    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, "{}");
      const cache = new WorkspaceResourceCache({ verificationTtlMs: 100, now: () => now });
      cache.setWatcherTrustProvider(() => false);

      assert.strictEqual(cache.getPackRoot(sourceFile), null);
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      now = 99;
      assert.strictEqual(cache.getPackRoot(sourceFile), null);
      now = 100;
      assert.strictEqual(cache.getPackRoot(sourceFile), packRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps filename-only resource inventory generations stable across text edits", () => {
    const cache = new WorkspaceResourceCache();
    const initialGeneration = cache.getResourceIndexGeneration();
    const initialMutationGeneration = cache.getResourceMutationGeneration();

    cache.invalidateDocument({
      fileName: path.resolve("pack", "assets", "minecraft", "items", "stick.json"),
      languageId: "json",
      version: 2,
      getText: () => "{}"
    });
    assert.strictEqual(cache.getResourceIndexGeneration(), initialGeneration);
    assert.strictEqual(cache.getResourceMutationGeneration(), initialMutationGeneration + 1);

    cache.invalidatePath(path.resolve("pack", "assets", "minecraft", "items", "new_item.json"));
    assert.strictEqual(cache.getResourceIndexGeneration(), initialGeneration + 1);
    assert.strictEqual(cache.getResourceMutationGeneration(), initialMutationGeneration + 2);
  });

  it("keeps the coordination facade free of cache storage details", () => {
    const servicesRoot = path.join(process.cwd(), "src", "services");
    const facade = fs.readFileSync(path.join(servicesRoot, "workspaceResourceCache.ts"), "utf8");
    const componentFiles = [
      "fileSystemResourceCache.ts",
      "resourceResolutionCache.ts",
      "modelResourceCache.ts",
      "mediaMetadataCache.ts"
    ];

    assert.strictEqual(facade.includes("new LruCache"), false);
    assert.strictEqual(facade.includes("new DependencyIndex"), false);
    assert.ok(facade.split(/\r?\n/).length < 250, "workspace cache facade should stay thin");
    for (const fileName of componentFiles) {
      assert.strictEqual(fs.existsSync(path.join(servicesRoot, fileName)), true, fileName);
    }
  });

  it("uses open document content for sounds.json event indexes", () => {
    const root = createTempDirectory();
    const soundsPath = path.join(root, "assets", "custom", "sounds.json");

    try {
      fs.mkdirSync(path.dirname(soundsPath), { recursive: true });
      fs.writeFileSync(soundsPath, JSON.stringify({ old: {} }));

      const cache = new WorkspaceResourceCache();
      cache.setOpenTextDocumentProvider(fileName => fileName === soundsPath
        ? {
          fileName: soundsPath,
          languageId: "json",
          version: 3,
          getText: () => JSON.stringify({ current: {} })
        }
        : null);

      const events = cache.getSoundEvents(soundsPath);

      assert.ok(events?.has("current"));
      assert.strictEqual(events?.has("old"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates cached negative PNG metadata", () => {
    const root = createTempDirectory();
    const pngPath = path.join(root, "pack.png");

    try {
      fs.writeFileSync(pngPath, Buffer.from("not png"));
      const cache = new WorkspaceResourceCache();

      assert.strictEqual(cache.getPngMetadata(pngPath), null);

      fs.writeFileSync(pngPath, createPngBytes(32, 16));
      cache.invalidatePath(pngPath);

      assert.deepStrictEqual(cache.getPngMetadata(pngPath), {
        width: 32,
        height: 16
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates cached negative OGG metadata", () => {
    const root = createTempDirectory();
    const oggPath = path.join(root, "sound.ogg");

    try {
      fs.writeFileSync(oggPath, Buffer.from("not ogg"));
      const cache = new WorkspaceResourceCache();

      assert.strictEqual(cache.getOggMetadata(oggPath), null);

      fs.writeFileSync(oggPath, createOggVorbisBytes(1, 22050, 22050));
      cache.invalidatePath(oggPath);

      assert.deepStrictEqual(cache.getOggMetadata(oggPath), {
        codec: "vorbis",
        channels: 1,
        sampleRate: 22050,
        durationSeconds: 1
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches pack metadata and refreshes after pack.mcmeta invalidation", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");
    const packMcmeta = path.join(packRoot, "pack.mcmeta");

    try {
      fs.mkdirSync(packRoot, { recursive: true });
      fs.writeFileSync(packMcmeta, JSON.stringify({
        overlays: {
          entries: [
            {
              directory: "overlay_one",
              ["min_format"]: [88, 0],
              ["max_format"]: [88, 0]
            }
          ]
        }
      }));

      const cache = new WorkspaceResourceCache();
      assert.deepStrictEqual(cache.getPackMetadata(packRoot).overlays.map(overlay => overlay.directory), ["overlay_one"]);

      fs.writeFileSync(packMcmeta, JSON.stringify({
        filter: {
          block: [
            {
              namespace: "minecraft",
              path: "textures/block/stone.*"
            }
          ]
        }
      }));
      cache.invalidatePath(packMcmeta);

      const metadata = cache.getPackMetadata(packRoot);
      assert.deepStrictEqual(metadata.overlays, []);
      assert.deepStrictEqual(metadata.filters, [{ namespace: "minecraft", path: "textures/block/stone.*" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves resources through configured lower-priority packs", () => {
    const root = createTempDirectory();
    const currentPack = path.join(root, "current");
    const lowerPack = path.join(root, "lower");
    const sourceModel = path.join(currentPack, "assets", "minecraft", "models", "block", "cube.json");
    const lowerTexture = path.join(lowerPack, "assets", "minecraft", "textures", "block", "stone.png");

    try {
      fs.mkdirSync(path.dirname(sourceModel), { recursive: true });
      fs.mkdirSync(path.dirname(lowerTexture), { recursive: true });
      fs.writeFileSync(path.join(currentPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(lowerPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceModel, "{}");
      fs.writeFileSync(lowerTexture, createPngBytes(16, 16));

      const cache = new WorkspaceResourceCache();
      const resolved = cache.resolveResourcePath({
        resourcePath: "minecraft:block/stone",
        sourceFileName: sourceModel,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: [lowerPack]
      });

      assert.strictEqual(resolved, lowerTexture);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates resource resolution entries when pack filters change", () => {
    const root = createTempDirectory();
    const currentPack = path.join(root, "current");
    const lowerPack = path.join(root, "lower");
    const currentPackMcmeta = path.join(currentPack, "pack.mcmeta");
    const sourceModel = path.join(currentPack, "assets", "minecraft", "models", "block", "cube.json");
    const lowerTexture = path.join(lowerPack, "assets", "minecraft", "textures", "block", "stone.png");

    try {
      fs.mkdirSync(path.dirname(sourceModel), { recursive: true });
      fs.mkdirSync(path.dirname(lowerTexture), { recursive: true });
      fs.writeFileSync(currentPackMcmeta, "{}");
      fs.writeFileSync(path.join(lowerPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceModel, "{}");
      fs.writeFileSync(lowerTexture, createPngBytes(16, 16));

      const cache = new WorkspaceResourceCache();
      const request = {
        resourcePath: "minecraft:block/stone",
        sourceFileName: sourceModel,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: [lowerPack]
      };

      assert.strictEqual(cache.resolveResourcePath(request), lowerTexture);

      fs.writeFileSync(currentPackMcmeta, JSON.stringify({
        filter: {
          block: [
            {
              namespace: "minecraft",
              path: "textures/block/stone.*"
            }
          ]
        }
      }));
      cache.invalidatePath(currentPackMcmeta);

      assert.strictEqual(cache.resolveResourcePath(request), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains unrelated resource resolution entries when pack metadata changes", () => {
    const root = createTempDirectory();
    const packA = path.join(root, "pack-a");
    const packB = path.join(root, "pack-b");
    const packAMcmeta = path.join(packA, "pack.mcmeta");
    const sourceA = path.join(packA, "assets", "minecraft", "models", "block", "cube.json");
    const sourceB = path.join(packB, "assets", "minecraft", "models", "block", "cube.json");
    const textureA = path.join(packA, "assets", "minecraft", "textures", "block", "stone.png");
    const textureB = path.join(packB, "assets", "minecraft", "textures", "block", "stone.png");

    try {
      for (const fileName of [sourceA, sourceB, textureA, textureB]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
      }
      fs.writeFileSync(packAMcmeta, "{}");
      fs.writeFileSync(path.join(packB, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceA, "{}");
      fs.writeFileSync(sourceB, "{}");
      fs.writeFileSync(textureA, createPngBytes(16, 16));
      fs.writeFileSync(textureB, createPngBytes(16, 16));

      const cache = new WorkspaceResourceCache();
      const requestA = {
        resourcePath: "minecraft:block/stone",
        sourceFileName: sourceA,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: []
      };
      const requestB = {
        resourcePath: "minecraft:block/stone",
        sourceFileName: sourceB,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: []
      };

      assert.strictEqual(cache.resolveResourcePath(requestA), textureA);
      assert.strictEqual(cache.resolveResourcePath(requestB), textureB);

      const hitsBefore = cache.getStats().hits.resourceResolution ?? 0;
      fs.writeFileSync(packAMcmeta, JSON.stringify({ filter: { block: [] } }));
      cache.invalidatePath(packAMcmeta);

      assert.strictEqual(cache.resolveResourcePath(requestB), textureB);
      assert.strictEqual(cache.getStats().hits.resourceResolution ?? 0, hitsBefore + 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates resource resolution entries by candidate path", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");
    const sourceModel = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
    const texturePath = path.join(packRoot, "assets", "minecraft", "textures", "block", "stone.png");

    try {
      fs.mkdirSync(path.dirname(sourceModel), { recursive: true });
      fs.mkdirSync(path.dirname(texturePath), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(sourceModel, "{}");

      const cache = new WorkspaceResourceCache();
      const request = {
        resourcePath: "minecraft:block/stone",
        sourceFileName: sourceModel,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: null,
        resourcePackRoots: []
      };

      assert.strictEqual(cache.resolveResourcePath(request), null);

      fs.writeFileSync(texturePath, createPngBytes(16, 16));
      cache.invalidatePath(texturePath);

      assert.strictEqual(cache.resolveResourcePath(request), texturePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches model parent chains through shared JSON AST and resource resolution", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");
    const childModel = path.join(packRoot, "assets", "minecraft", "models", "block", "child.json");
    const parentModel = path.join(packRoot, "assets", "minecraft", "models", "block", "parent.json");

    try {
      fs.mkdirSync(path.dirname(childModel), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      fs.writeFileSync(childModel, JSON.stringify({
        parent: "minecraft:block/parent",
        textures: {
          layer0: "minecraft:block/local"
        }
      }));
      fs.writeFileSync(parentModel, JSON.stringify({
        textures: {
          layer0: "minecraft:block/parent",
          all: "minecraft:block/stone"
        }
      }));

      const cache = new WorkspaceResourceCache();
      const childAst = cache.getJsonFileAst(childModel);
      assert.ok(childAst);

      const chain = cache.getModelParentChain(
        {
          fileName: childModel,
          languageId: "json",
          getText: () => fs.readFileSync(childModel, "utf8")
        },
        childAst,
        { defaultAssetsPath: null, resourcePackRoots: [] },
        "models/block"
      );

      assert.deepStrictEqual(chain.map(model => model.fileName), [childModel, parentModel]);

      const definitions = cache.getModelTextureVariableDefinitions(
        {
          fileName: childModel,
          languageId: "json",
          getText: () => fs.readFileSync(childModel, "utf8")
        },
        childAst,
        { defaultAssetsPath: null, resourcePackRoots: [] },
        "models/block"
      );
      assert.strictEqual(definitions.get("layer0")?.fileName, childModel);
      assert.strictEqual(definitions.get("all")?.fileName, parentModel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

