import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewCancellationSource } from "../../../modelPreview/cancellation";
import { dependencyKey } from "../../../modelPreview/paths";
import { ModelDependencyTracker } from "../../../modelPreview/service/ModelDependencyTracker";
import {
  ModelPreviewConsistencyError,
  ModelPreviewService
} from "../../../modelPreview/service/ModelPreviewService";
import { WorkspaceResourceCache } from "../../../services/workspaceResourceCache";
import { createPack, createRgbaPng, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "../helpers/tempPack";
import { createService } from "./previewServiceTestSupport";

describe("model preview dependency tracking, caching, and cancellation", () => {
  it("tracks dependency hits for file and configuration changes", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/simple.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/stone.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/simple.json"));
      const tracker = new ModelDependencyTracker();
      tracker.update(preview);

      const textureFileName = path.join(pack, "assets/minecraft/textures/block/stone.png");
      assert.strictEqual(tracker.hasFile(textureFileName), true);
      assert.strictEqual(tracker.hasFileAtOrBelow(path.dirname(textureFileName)), true);
      assert.strictEqual(tracker.hasFileAtOrBelow(path.join(pack, "assets/minecraft/sounds")), false);
      assert.strictEqual(tracker.hasFile(path.join(pack, "assets/minecraft/textures/block/dirt.png")), false);
      assert.strictEqual(tracker.hasConfiguration("McResHelper.defaultMcAssetsPath"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("invalidates cached preview documents by dependency", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/simple.json");
      writeJson(pack, "assets/minecraft/models/block/simple.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/stone.png", "png");

      const service = createService();
      const first = await service.getPreviewDocument(modelFileName);
      writeJson(pack, "assets/minecraft/models/block/simple.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              north: { texture: "#all" },
              south: { texture: "#all" }
            }
          }
        ]
      });
      const cached = await service.getPreviewDocument(modelFileName);
      service.invalidateDependents(modelFileName);
      const refreshed = await service.getPreviewDocument(modelFileName);

      assert.strictEqual(first.meshes[0].faces.length, 1);
      assert.strictEqual(cached.meshes[0].faces.length, 1);
      assert.strictEqual(refreshed.meshes[0].faces.length, 2);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("invalidates cached previews when missing texture dependencies are created", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/simple.json");
      const missingTexture = path.join(pack, "assets/minecraft/textures/block/later.png");
      writeJson(pack, "assets/minecraft/models/block/simple.json", {
        textures: { all: "minecraft:block/later" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });

      const service = createService();
      const missing = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(missing.materials[0].fallback, "missing");
      assert.ok(missing.dependencies.some(dependency =>
        dependency.kind === "texture" &&
        (dependency.uri.endsWith("/later.png") || dependency.uri.endsWith("later.png"))
      ));

      writeFile(pack, "assets/minecraft/textures/block/later.png", "png");
      service.invalidateDependents(missingTexture);
      const refreshed = await service.getPreviewDocument(modelFileName);

      assert.strictEqual(refreshed.materials[0].fallback, "texture");
      assert.match(refreshed.materials[0].textureUri ?? "", /later\.png$/);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("invalidates cached previews when missing parent models are created", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/child.json");
      const parentFileName = path.join(pack, "assets/minecraft/models/block/later_parent.json");
      writeJson(pack, "assets/minecraft/models/block/child.json", {
        parent: "minecraft:block/later_parent"
      });

      const service = createService();
      const missing = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(missing.meshes.length, 0);
      assert.ok(missing.dependencies.some(dependency =>
        dependency.kind === "model" &&
        (dependency.uri.endsWith("/later_parent.json") || dependency.uri.endsWith("later_parent.json"))
      ));

      writeJson(pack, "assets/minecraft/models/block/later_parent.json", {
        elements: [{
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: "minecraft:block/stone" } }
        }]
      });
      service.invalidateDependents(parentFileName);
      const refreshed = await service.getPreviewDocument(modelFileName);

      assert.strictEqual(refreshed.meshes.length, 1);
      assert.strictEqual(refreshed.meshes[0].faces.length, 1);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("switches from a lower-pack parent when a higher-priority candidate is created", async () => {
    const root = createTempDirectory();

    try {
      const currentPack = createPack(root, "current-parent");
      const lowerPack = createPack(root, "lower-parent");
      const childFileName = path.join(currentPack, "assets/minecraft/models/block/child.json");
      const overrideCandidate = path.join(currentPack, "assets/minecraft/models/block/fallback_parent.json");
      writeJson(currentPack, "assets/minecraft/models/block/child.json", {
        parent: "minecraft:block/fallback_parent"
      });
      writeJson(lowerPack, "assets/minecraft/models/block/fallback_parent.json", modelWithFaces("north"));
      const service = createService({ resourcePackRoots: [lowerPack] });

      const fallback = await service.getPreviewDocument(childFileName);
      assert.strictEqual(fallback.meshes[0].faces.length, 1);
      const missingOverride = fallback.dependencies.find(dependency =>
        dependency.kind === "model" &&
        dependency.uri.includes("/current-parent/") &&
        dependency.uri.endsWith("/fallback_parent.json")
      );
      const selectedParent = fallback.dependencies.find(dependency =>
        dependency.kind === "model" &&
        dependency.uri.includes("/lower-parent/") &&
        dependency.uri.endsWith("/fallback_parent.json")
      );
      assert.strictEqual(missingOverride?.watchOnly, true, "the missing higher-priority parent must remain watchable");
      assert.ok(selectedParent);
      assert.notStrictEqual(selectedParent.watchOnly, true, "the selected parent must remain displayable");

      writeJson(currentPack, "assets/minecraft/models/block/fallback_parent.json", modelWithFaces("north", "south"));
      service.invalidateDependents(overrideCandidate);
      const overridden = await service.getPreviewDocument(childFileName);
      assert.strictEqual(overridden.meshes[0].faces.length, 2);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("switches from a lower-pack texture when a higher-priority candidate is created", async () => {
    const root = createTempDirectory();

    try {
      const currentPack = createPack(root, "current-texture");
      const lowerPack = createPack(root, "lower-texture");
      const modelFileName = path.join(currentPack, "assets/minecraft/models/block/textured.json");
      const overrideCandidate = path.join(currentPack, "assets/minecraft/textures/block/override.png");
      writeJson(currentPack, "assets/minecraft/models/block/textured.json", texturedCubeModel("minecraft:block/override"));
      writeFile(lowerPack, "assets/minecraft/textures/block/override.png", "lower");
      const service = createService({ resourcePackRoots: [lowerPack] });

      const fallback = await service.getPreviewDocument(modelFileName);
      assert.match(fallback.materials[0].textureUri ?? "", /lower-texture.*override\.png$/);
      const missingOverride = fallback.dependencies.find(dependency =>
        dependency.kind === "texture" &&
        dependency.uri.includes("/current-texture/") &&
        dependency.uri.endsWith("/override.png")
      );
      const selectedTexture = fallback.dependencies.find(dependency =>
        dependency.kind === "texture" &&
        dependency.uri.includes("/lower-texture/") &&
        dependency.uri.endsWith("/override.png")
      );
      assert.strictEqual(missingOverride?.watchOnly, true, "the missing higher-priority texture must remain watchable");
      assert.ok(selectedTexture);
      assert.notStrictEqual(selectedTexture.watchOnly, true, "the selected texture must remain displayable");

      writeFile(currentPack, "assets/minecraft/textures/block/override.png", "higher");
      service.invalidateDependents(overrideCandidate);
      const overridden = await service.getPreviewDocument(modelFileName);
      assert.match(overridden.materials[0].textureUri ?? "", /current-texture.*override\.png$/);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("reuses raw model, resolved model, and texture alpha caches across preview IR rebuilds", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/item/cached.json");
      writeJson(pack, "assets/minecraft/models/item/cached.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "minecraft:item/cached"
        }
      });
      writeFile(pack, "assets/minecraft/textures/item/cached.png", createRgbaPng(2, 2, () => 255));

      const counters = { textReads: 0, binaryReads: 0 };
      const service = createService({}, createCountingFileSystem(counters));
      await service.getPreviewDocument(modelFileName);
      const afterFirst = { ...counters };
      service.invalidate(modelFileName);
      await service.getPreviewDocument(modelFileName);

      assert.ok(afterFirst.textReads > 0);
      assert.ok(afterFirst.binaryReads > 0);
      assert.strictEqual(counters.textReads, afterFirst.textReads, "resolved/raw model cache should avoid reparsing unchanged model JSON");
      assert.strictEqual(counters.binaryReads, afterFirst.binaryReads, "texture alpha cache should avoid rereading unchanged PNG dimensions");
    } finally {
      removeTempDirectory(root);
    }
  });

  it("retries a preview assembled across resource generations without caching stale resolution", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const childFileName = path.join(pack, "assets/minecraft/models/block/child.json");
      const parentFileName = path.join(pack, "assets/minecraft/models/block/parent.json");
      writeJson(pack, "assets/minecraft/models/block/child.json", {
        parent: "minecraft:block/parent"
      });
      writeJson(pack, "assets/minecraft/models/block/parent.json", modelWithFaces("north"));

      let parentVersion = "v1";
      let parentReads = 0;
      const parentReadStarted = deferred<void>();
      const releaseStaleRead = deferred<void>();
      const fileSystem: ModelPreviewFileSystem = {
        async readTextFile(fileName) {
          const snapshot = await fs.promises.readFile(fileName, "utf8");
          if (path.normalize(fileName) === path.normalize(parentFileName) && parentReads++ === 0) {
            parentReadStarted.resolve(undefined);
            await releaseStaleRead.promise;
          }
          return snapshot;
        },
        readBinaryFile: fileName => fs.promises.readFile(fileName),
        fileExists: fileName => fs.existsSync(fileName),
        fileVersion: fileName => path.normalize(fileName) === path.normalize(parentFileName)
          ? parentVersion
          : fs.existsSync(fileName) ? "present" : "missing"
      };
      const service = createService({}, fileSystem);
      const pendingPreview = service.getPreviewDocument(childFileName);

      await parentReadStarted.promise;
      writeJson(pack, "assets/minecraft/models/block/parent.json", modelWithFaces("north", "south"));
      parentVersion = "v2";
      releaseStaleRead.resolve(undefined);

      const preview = await pendingPreview;
      assert.strictEqual(preview.meshes[0].faces.length, 2, "mixed-generation preview must be discarded and rebuilt");
      assert.strictEqual(parentReads, 2, "the changed parent should be read again");

      service.invalidate(childFileName);
      const cachedResolution = await service.getPreviewDocument(childFileName);
      assert.strictEqual(cachedResolution.meshes[0].faces.length, 2, "stale resolved model must not be tagged with the new generation");
    } finally {
      removeTempDirectory(root);
    }
  });

  it("does not retry when an unrelated workspace resource changes during a preview build", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/stable.json");
      const unrelatedFileName = path.join(pack, "assets/minecraft/lang/en_us.json");
      writeJson(pack, "assets/minecraft/models/block/stable.json", modelWithFaces("north"));
      writeJson(pack, "assets/minecraft/lang/en_us.json", {});
      const cache = new WorkspaceResourceCache();
      cache.setWatcherTrustProvider(() => true);
      const readStarted = deferred<void>();
      const releaseRead = deferred<void>();
      let modelReads = 0;
      const service = new ModelPreviewService({
        artifactCache: cache.modelPreviewArtifacts,
        fileSystem: workspaceBackedFileSystem(cache, async fileName => {
          const text = await fs.promises.readFile(fileName, "utf8");
          if (path.normalize(fileName) === path.normalize(modelFileName)) {
            modelReads++;
            readStarted.resolve(undefined);
            await releaseRead.promise;
          }
          return text;
        })
      });
      const pending = service.getPreviewDocument(modelFileName);

      await readStarted.promise;
      cache.invalidatePath(unrelatedFileName);
      releaseRead.resolve(undefined);
      const preview = await pending;

      assert.strictEqual(preview.meshes[0].faces.length, 1);
      assert.strictEqual(modelReads, 1, "unrelated mutation must not starve or restart the preview");
    } finally {
      removeTempDirectory(root);
    }
  });

  it("fails safely after the bounded number of fallback consistency retries", async () => {
    let generationChecks = 0;
    let reads = 0;
    const service = createService({}, {
      async readTextFile() {
        reads++;
        return JSON.stringify(modelWithFaces("north"));
      },
      readBinaryFile: async () => new Uint8Array(),
      fileExists: () => false,
      getResourceGeneration: () => generationChecks++,
      fileVersion: () => "stable"
    });

    await assert.rejects(
      service.getPreviewDocument(path.resolve("virtual", "assets/minecraft/models/block/changing.json")),
      ModelPreviewConsistencyError
    );
    assert.strictEqual(generationChecks, 6, "three attempts should each capture and verify once");
    assert.ok(reads >= 1);
  });

  it("refreshes pack-root, overlay, and filter resolution across pack.mcmeta create/change/delete", async () => {
    const root = createTempDirectory();

    try {
      const outerPack = createPack(root, "outer");
      const nestedPack = path.join(outerPack, "nested");
      const lowerPack = createPack(root, "lower");
      const modelFileName = path.join(nestedPack, "assets/minecraft/models/block/custom.json");
      const nestedPackMetadata = path.join(nestedPack, "pack.mcmeta");
      const outerPackMetadata = path.join(outerPack, "pack.mcmeta");
      const lowerPackMetadata = path.join(lowerPack, "pack.mcmeta");
      const overlayTexture = path.join(nestedPack, "overlay", "assets/minecraft/textures/block/lower_only.png");

      writeJson(nestedPack, "assets/minecraft/models/block/custom.json", texturedCubeModel("minecraft:block/lower_only"));
      writeFile(lowerPack, "assets/minecraft/textures/block/lower_only.png", "lower");
      writeJson(outerPack, "pack.mcmeta", filteringPackMetadata("textures/block/lower_only.*"));

      const cache = new WorkspaceResourceCache();
      cache.setWatcherTrustProvider(() => true);
      const service = createWorkspaceBackedService(cache, [lowerPack]);

      const blockedByOuter = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(blockedByOuter.materials[0].fallback, "missing");
      const tracker = new ModelDependencyTracker();
      tracker.update(blockedByOuter);
      assert.strictEqual(tracker.hasFile(nestedPackMetadata), true, "missing closer pack root must remain a create dependency");
      assert.strictEqual(tracker.hasFile(outerPackMetadata), true, "current pack metadata must remain a change/delete dependency");
      assert.strictEqual(tracker.hasFile(lowerPackMetadata), true, "configured pack metadata must remain a filter/overlay dependency");
      const dependencyFor = (fileName: string) => blockedByOuter.dependencies.find(dependency =>
        dependency.kind === "packMetadata" && dependencyKey(dependency.uri) === dependencyKey(fileName)
      );
      assert.strictEqual(dependencyFor(nestedPackMetadata)?.watchOnly, true);
      assert.notStrictEqual(dependencyFor(outerPackMetadata)?.watchOnly, true);
      assert.notStrictEqual(dependencyFor(lowerPackMetadata)?.watchOnly, true);

      writeJson(nestedPack, "pack.mcmeta", basePackMetadata());
      invalidatePreviewPath(cache, service, nestedPackMetadata);
      const afterCreate = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(afterCreate.materials[0].fallback, "texture");
      assert.match(afterCreate.materials[0].textureUri ?? "", /lower[\\/].*lower_only\.png|lower_only\.png$/);

      writeFile(nestedPack, "overlay/assets/minecraft/textures/block/lower_only.png", "overlay");
      writeJson(nestedPack, "pack.mcmeta", overlayPackMetadata("overlay"));
      cache.invalidatePath(overlayTexture);
      invalidatePreviewPath(cache, service, nestedPackMetadata);
      const afterOverlayChange = await service.getPreviewDocument(modelFileName);
      assert.match(afterOverlayChange.materials[0].textureUri ?? "", /overlay[\\/].*lower_only\.png|overlay.*lower_only\.png$/);

      writeJson(outerPack, "pack.mcmeta", basePackMetadata());
      cache.invalidatePath(outerPackMetadata);
      writeJson(nestedPack, "pack.mcmeta", filteringPackMetadata("textures/block/lower_only.*"));
      invalidatePreviewPath(cache, service, nestedPackMetadata);
      const afterFilterChange = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(afterFilterChange.materials[0].fallback, "missing");

      fs.rmSync(nestedPackMetadata);
      invalidatePreviewPath(cache, service, nestedPackMetadata);
      const afterDelete = await service.getPreviewDocument(modelFileName);
      assert.strictEqual(afterDelete.materials[0].fallback, "texture");
      assert.match(afterDelete.materials[0].textureUri ?? "", /lower_only\.png$/);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("cancels stale preview requests while parsing", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/slow.json");
      writeJson(pack, "assets/minecraft/models/block/slow.json", {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#missing" } }
          }
        ]
      });
      const readGate: { release?: () => void } = {};
      const fileSystem: ModelPreviewFileSystem = {
        readTextFile: async fileName => {
          await new Promise<void>(resolve => {
            readGate.release = resolve;
          });
          return fs.promises.readFile(fileName, "utf8");
        },
        readBinaryFile: fileName => fs.promises.readFile(fileName),
        fileExists: fileName => fs.existsSync(fileName),
        fileVersion: fileName => {
          try {
            const stat = fs.statSync(fileName);
            return `${stat.mtimeMs}:${stat.size}`;
          } catch {
            return null;
          }
        }
      };
      const cancellation = new ModelPreviewCancellationSource();
      const preview = createService({}, fileSystem).getPreviewDocument(modelFileName, cancellation.token);

      cancellation.cancel();
      assert.ok(readGate.release);
      readGate.release();

      await assert.rejects(preview, /cancelled/i);
    } finally {
      removeTempDirectory(root);
    }
  });
});

function createCountingFileSystem(counters: { textReads: number; binaryReads: number }): ModelPreviewFileSystem {
  return {
    async readTextFile(fileName) {
      counters.textReads++;
      return fs.promises.readFile(fileName, "utf8");
    },
    async readBinaryFile(fileName) {
      counters.binaryReads++;
      return fs.promises.readFile(fileName);
    },
    fileExists: fileName => fs.existsSync(fileName),
    fileVersion: fileName => {
      try {
        const stat = fs.statSync(fileName);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return null;
      }
    }
  };
}

function createWorkspaceBackedService(
  cache: WorkspaceResourceCache,
  resourcePackRoots: string[]
): ModelPreviewService {
  return new ModelPreviewService({
    configuration: () => ({ resourcePackRoots }),
    artifactCache: cache.modelPreviewArtifacts,
    fileSystem: workspaceBackedFileSystem(cache)
  });
}

function workspaceBackedFileSystem(
  cache: WorkspaceResourceCache,
  readTextFile: (fileName: string) => Promise<string> = fileName => fs.promises.readFile(fileName, "utf8")
): ModelPreviewFileSystem {
  return {
    readTextFile,
    readBinaryFile: fileName => fs.promises.readFile(fileName),
    fileExists: fileName => cache.getPathExists(fileName),
    getResourceGeneration: () => cache.getResourceMutationGeneration(),
    hasAnyResourceChangedSince: (generation, fileNames) =>
      cache.hasAnyResourceChangedSince(generation, fileNames),
    fileVersion: fileName => cache.getFileVersion(fileName),
    getPackRoot: fileName => cache.getPackRoot(fileName),
    getPackMetadata: packRoot => cache.getPackMetadata(packRoot)
  };
}

function invalidatePreviewPath(
  cache: WorkspaceResourceCache,
  service: ModelPreviewService,
  fileName: string
): void {
  cache.invalidatePath(fileName);
  service.invalidateDependents(fileName);
}

function modelWithFaces(...directions: Array<"north" | "south">): unknown {
  return {
    elements: [{
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: Object.fromEntries(directions.map(direction => [
        direction,
        { texture: "minecraft:block/stone" }
      ]))
    }]
  };
}

function texturedCubeModel(texture: string): unknown {
  return {
    textures: { all: texture },
    elements: [{
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: { north: { texture: "#all" } }
    }]
  };
}

function basePackMetadata(): unknown {
  return {
    pack: {
      ["min_format"]: [88, 0],
      ["max_format"]: [88, 0],
      description: "test"
    }
  };
}

function overlayPackMetadata(directory: string): unknown {
  return {
    ...basePackMetadata() as object,
    overlays: {
      entries: [{
        directory,
        ["min_format"]: [88, 0],
        ["max_format"]: [88, 0]
      }]
    }
  };
}

function filteringPackMetadata(resourcePath: string): unknown {
  return {
    ...basePackMetadata() as object,
    filter: {
      block: [{ namespace: "minecraft", path: resourcePath }]
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? undefined : T) => void;
} {
  let resolve!: (value: T extends void ? undefined : T) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve as (value: T extends void ? undefined : T) => void;
  });
  return { promise, resolve };
}
