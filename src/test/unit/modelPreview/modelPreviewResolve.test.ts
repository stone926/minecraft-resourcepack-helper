import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PreviewIssue } from "../../../modelPreview/ir/PreviewDocument";
import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { fileUriString } from "../../../modelPreview/paths";
import { createPack, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "../helpers/tempPack";
import { createService } from "./previewServiceTestSupport";

describe("model preview parent and texture resolution", () => {
  it("merges parent elements with child texture overrides", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/cube_all.json", {
        textures: {
          all: "minecraft:block/stone"
        },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              north: { texture: "#all" }
            }
          }
        ]
      });
      writeJson(pack, "assets/minecraft/models/block/custom.json", {
        parent: "minecraft:block/cube_all",
        textures: {
          all: "minecraft:block/custom"
        }
      });
      writeFile(pack, "assets/minecraft/textures/block/custom.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/custom.json"));

      assert.strictEqual(preview.resourceId, "minecraft:block/custom");
      assert.strictEqual(preview.meshes.length, 1);
      assert.strictEqual(preview.meshes[0].faces.length, 1);
      assert.strictEqual(preview.materials[0].fallback, "texture");
      assert.ok(preview.materials[0].textureVersion, "texture materials should carry file dependency versions for webview caching");
      assert.match(preview.materials[0].textureUri ?? "", /custom\.png$/);
      const parentDependency = preview.dependencies.find(dependency =>
        dependency.uri.endsWith("/cube_all.json") || dependency.uri.endsWith("cube_all.json")
      );
      const textureDependency = preview.dependencies.find(dependency =>
        dependency.uri.endsWith("/custom.png") || dependency.uri.endsWith("custom.png")
      );
      assert.ok(parentDependency);
      assert.notStrictEqual(parentDependency.watchOnly, true, "the selected parent must remain displayable");
      assert.ok(textureDependency);
      assert.notStrictEqual(textureDependency.watchOnly, true, "the selected texture must remain displayable");
      assert.deepStrictEqual(preview.issues.filter(issue => issue.severity === "error"), []);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("resolves texture variable chains and texture object metadata", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/item/test.json", {
        textures: {
          layer0: "#resolved",
          resolved: {
            sprite: "minecraft:item/custom",
            ["force_translucent"]: true
          }
        },
        elements: [
          {
            from: [0, 0, 7],
            to: [16, 16, 9],
            faces: {
              north: { texture: "#layer0" }
            }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/item/custom.png", "png");
      writeJson(pack, "assets/minecraft/textures/item/custom.png.mcmeta", { animation: { frametime: 2 } });

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/item/test.json"));

      assert.strictEqual(preview.materials.length, 1);
      assert.strictEqual(preview.materials[0].transparent, true);
      assert.ok(preview.dependencies.some(dependency => dependency.kind === "textureMetadata"));
      assert.ok(preview.issues.some(issue => issue.severity === "info" && issueMessageKey(issue).includes("Animated texture metadata")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("caches texture resource resolution within one preview build", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const modelFileName = path.join(pack, "assets", "minecraft", "models", "block", "cached_textures.json");
      const textureFileName = path.join(pack, "assets", "minecraft", "textures", "block", "shared.png");
      writeJson(pack, "assets/minecraft/models/block/cached_textures.json", {
        textures: {
          north: "minecraft:block/shared",
          south: "minecraft:block/shared"
        },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              north: { texture: "#north" },
              south: { texture: "#south" }
            }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/shared.png", "png");

      let textureExistsChecks = 0;
      const fileSystem = createCountingTextureFileSystem(textureFileName, () => textureExistsChecks++);
      const preview = await createService({}, fileSystem).getPreviewDocument(modelFileName);

      assert.strictEqual(preview.materials.length, 1);
      assert.strictEqual(textureExistsChecks, 1);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("reports missing parents and missing texture variables without blocking preview creation", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/broken.json", {
        parent: "minecraft:block/missing_parent",
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              north: { texture: "#missing" }
            }
          }
        ]
      });

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/broken.json"));

      assert.strictEqual(preview.meshes.length, 1);
      assert.strictEqual(preview.materials[0].fallback, "missing");
      assert.ok(preview.issues.some(issue => issue.severity === "warning" && issueMessageKey(issue).includes("Parent model not found")));
      assert.ok(preview.issues.some(issue => issue.severity === "warning" && issueMessageKey(issue).includes("Texture variable not found")));
      assert.ok(preview.issues.find(issue => issueMessageKey(issue).includes("Parent model not found"))?.range);
      assert.ok(preview.issues.find(issue => issueMessageKey(issue).includes("Texture variable not found"))?.range);
      assert.ok(preview.dependencies.some(dependency =>
        dependency.kind === "model" &&
        (dependency.uri.endsWith("/missing_parent.json") || dependency.uri.endsWith("missing_parent.json"))
      ));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("adds ranges to invalid JSON and out-of-range field issues", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const invalidModel = path.join(pack, "assets/minecraft/models/block/invalid.json");
      writeFile(pack, "assets/minecraft/models/block/invalid.json", "{ \"parent\": ");

      const invalidPreview = await createService().getPreviewDocument(invalidModel);

      assert.ok(invalidPreview.issues.some(issue =>
        issue.severity === "error" &&
        issueMessageKey(issue).includes("could not be parsed") &&
        !!issue.range
      ));

      writeJson(pack, "assets/minecraft/models/block/out_of_range.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [40, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/stone.png", "png");

      const outOfRangePreview = await createService()
        .getPreviewDocument(path.join(pack, "assets/minecraft/models/block/out_of_range.json"));

      assert.ok(outOfRangePreview.issues.some(issue =>
        issue.severity === "warning" &&
        issueMessageKey(issue).includes("outside Minecraft's supported") &&
        !!issue.range
      ));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("detects parent cycles", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/a.json", {
        parent: "minecraft:block/b",
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ],
        textures: { all: "minecraft:block/a" }
      });
      writeJson(pack, "assets/minecraft/models/block/b.json", {
        parent: "minecraft:block/a",
        textures: { all: "minecraft:block/b" }
      });
      writeFile(pack, "assets/minecraft/textures/block/a.png", "png");
      writeFile(pack, "assets/minecraft/textures/block/b.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/a.json"));

      assert.ok(preview.issues.some(issue => issue.severity === "error" && issueMessageKey(issue).includes("Parent model cycle")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("uses default assets as a fallback for parent models", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const defaultAssets = path.join(root, "default");
      const defaultParent = path.join(defaultAssets, "assets/minecraft/models/block/cube_all.json");
      writeJson(defaultAssets, "assets/minecraft/models/block/cube_all.json", {
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

      const preview = await createService({ defaultAssetsPath: defaultAssets })
        .getPreviewDocument(path.join(pack, "assets/minecraft/models/block/custom.json"));

      assert.strictEqual(preview.meshes.length, 1);
      const selectedParent = preview.dependencies.find(dependency => dependency.uri === fileUriString(defaultParent));
      const unusedDefaultCandidates = preview.dependencies.filter(dependency =>
        dependency.kind === "model" &&
        dependency.uri !== fileUriString(defaultParent) &&
        (dependency.uri.includes("/default/") || dependency.uri.includes("%5Cdefault%5C")) &&
        dependency.uri.endsWith("cube_all.json")
      );
      assert.ok(selectedParent);
      assert.notStrictEqual(selectedParent.watchOnly, true, "the selected default-layout candidate must be displayable");
      assert.ok(unusedDefaultCandidates.length >= 2, "default assets should retain alternate layout candidates for invalidation");
      assert.ok(unusedDefaultCandidates.every(dependency => dependency.watchOnly === true));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("keeps existing but unused default-asset candidates out of the displayed dependency set", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const defaultAssets = createPack(root, "default");
      const currentTexture = path.join(pack, "assets/minecraft/textures/block/custom.png");
      const unusedDefaultTexture = path.join(defaultAssets, "assets/minecraft/textures/block/custom.png");
      const unusedDefaultMetadata = path.join(defaultAssets, "pack.mcmeta");
      writeJson(pack, "assets/minecraft/models/block/custom.json", {
        textures: { all: "minecraft:block/custom" },
        elements: [{
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: "#all" } }
        }]
      });
      writeFile(pack, "assets/minecraft/textures/block/custom.png", "current");
      writeFile(defaultAssets, "assets/minecraft/textures/block/custom.png", "default");

      const preview = await createService({ defaultAssetsPath: defaultAssets })
        .getPreviewDocument(path.join(pack, "assets/minecraft/models/block/custom.json"));

      const dependencyFor = (fileName: string) => preview.dependencies.find(dependency =>
        dependency.uri === fileUriString(fileName)
      );
      assert.match(preview.materials[0].textureUri ?? "", /[\\/]pack[\\/].*custom\.png$/);
      assert.notStrictEqual(dependencyFor(currentTexture)?.watchOnly, true);
      assert.strictEqual(dependencyFor(unusedDefaultTexture)?.watchOnly, true);
      assert.strictEqual(dependencyFor(unusedDefaultMetadata)?.watchOnly, true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("uses configured lower-priority packs for texture fallback", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const lowerPack = createPack(root, "lower");
      writeJson(pack, "assets/minecraft/models/block/custom.json", {
        textures: { all: "minecraft:block/lower_only" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeFile(lowerPack, "assets/minecraft/textures/block/lower_only.png", "png");

      const preview = await createService({ resourcePackRoots: [lowerPack] })
        .getPreviewDocument(path.join(pack, "assets/minecraft/models/block/custom.json"));

      assert.match(preview.materials[0].textureUri ?? "", /lower_only\.png$/);
      assert.ok(preview.dependencies.some(dependency => dependency.uri.includes("/lower/") || dependency.uri.includes("%5Clower%5C")));
    } finally {
      removeTempDirectory(root);
    }
  });
});

function issueMessageKey(issue: PreviewIssue): string {
  return issue.message.message;
}

function createCountingTextureFileSystem(textureFileName: string, onTextureExistsCheck: () => void): ModelPreviewFileSystem {
  return {
    readTextFile: fileName => fs.promises.readFile(fileName, "utf8"),
    readBinaryFile: fileName => fs.promises.readFile(fileName),
    fileExists: fileName => {
      if (fileName === textureFileName) {
        onTextureExistsCheck();
      }
      return fs.existsSync(fileName);
    },
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
