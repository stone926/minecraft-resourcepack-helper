import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewCancellationSource } from "../../../modelPreview/service/ModelPreviewCancellation";
import { ModelDependencyTracker } from "../../../modelPreview/service/ModelDependencyTracker";
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

      assert.strictEqual(tracker.hasFile(path.join(pack, "assets/minecraft/textures/block/stone.png")), true);
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
