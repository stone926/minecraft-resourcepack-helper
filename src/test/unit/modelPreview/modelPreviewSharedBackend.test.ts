import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceFileRequest } from "../../../../packages/mc-assets/src";
import { createWorkspaceCacheModelLoader } from "../../../modelPreview/host/workspaceCacheModelBackend";
import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import type { ParentChainModelLoader } from "../../../modelPreview/resolve/RawModelLoader";
import { ModelPreviewService } from "../../../modelPreview/service/ModelPreviewService";
import { WorkspaceResourceCache, workspaceResourceCache } from "../../../services/workspaceResourceCache";
import { createPack, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "../helpers/tempPack";

describe("model preview shared workspace backend", () => {
  it("loads parent chains through the injected loader and shared resolution", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/cube_all.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeJson(pack, "assets/minecraft/models/block/custom.json", {
        parent: "minecraft:block/cube_all",
        textures: { all: "minecraft:block/custom" }
      });
      writeFile(pack, "assets/minecraft/textures/block/custom.png", "png");

      const cache = new WorkspaceResourceCache();
      cache.setWatcherTrustProvider(() => true);
      const parsedFiles: string[] = [];
      const sharedResolutions: ResourceFileRequest[] = [];
      const modelLoader: ParentChainModelLoader = {
        readModelText: fileName => fs.promises.readFile(fileName, "utf8"),
        parseModelValue: (fileName, text) => {
          parsedFiles.push(path.normalize(fileName));
          return JSON.parse(text);
        }
      };
      const service = new ModelPreviewService({
        modelLoader,
        resolveResourcePath: request => {
          sharedResolutions.push(request);
          return cache.resolveResourcePath(request);
        }
      });
      const childFileName = path.join(pack, "assets/minecraft/models/block/custom.json");
      const parentFileName = path.join(pack, "assets/minecraft/models/block/cube_all.json");

      const preview = await service.getPreviewDocument(childFileName);

      assert.strictEqual(preview.resourceId, "minecraft:block/custom");
      assert.strictEqual(preview.meshes.length, 1);
      assert.match(preview.materials[0].textureUri ?? "", /custom\.png$/);
      assert.deepStrictEqual(parsedFiles, [path.normalize(childFileName), path.normalize(parentFileName)]);
      assert.ok(sharedResolutions.some(request =>
        request.target === "models" && request.resourcePath === "minecraft:block/cube_all"
      ), "parent lookup should route through the injected shared resolution");
      assert.deepStrictEqual(preview.issues.filter(issue => issue.severity === "error"), []);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("parses model values through the shared AST cache and keeps parse-error positions", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets/minecraft/models/block/shared.json");
      const brokenFileName = path.join(pack, "assets/minecraft/models/block/broken.json");
      writeJson(pack, "assets/minecraft/models/block/shared.json", {
        parent: "minecraft:block/cube_all",
        textures: { all: "minecraft:block/stone" }
      });
      writeFile(pack, "assets/minecraft/models/block/broken.json", "{ not json");
      workspaceResourceCache.invalidateAll();
      const fileSystem: ModelPreviewFileSystem = {
        readTextFile: fileName => fs.promises.readFile(fileName, "utf8"),
        readBinaryFile: fileName => fs.promises.readFile(fileName),
        fileExists: fileName => fs.existsSync(fileName)
      };
      const loader = createWorkspaceCacheModelLoader(fileSystem);

      assert.deepStrictEqual(
        loader.parseModelValue(modelFileName, await loader.readModelText(modelFileName)),
        { parent: "minecraft:block/cube_all", textures: { all: "minecraft:block/stone" } }
      );

      const brokenText = await loader.readModelText(brokenFileName);
      assert.throws(
        () => loader.parseModelValue(brokenFileName, brokenText),
        /position \d+/,
        "parse failures must keep a position for issue ranges"
      );
    } finally {
      removeTempDirectory(root);
    }
  });
});
