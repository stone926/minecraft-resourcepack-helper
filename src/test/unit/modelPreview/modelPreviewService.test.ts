import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultUv, getFaceUvs } from "../../../modelPreview/bake/DefaultUv";
import { ModelDependencyTracker } from "../../../modelPreview/service/ModelDependencyTracker";
import { ModelPreviewService } from "../../../modelPreview/service/ModelPreviewService";

describe("model preview service", () => {
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
      assert.match(preview.materials[0].textureUri ?? "", /custom\.png$/);
      assert.ok(preview.dependencies.some(dependency => dependency.uri.endsWith("/cube_all.json") || dependency.uri.endsWith("cube_all.json")));
      assert.ok(preview.dependencies.some(dependency => dependency.uri.endsWith("/custom.png") || dependency.uri.endsWith("custom.png")));
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
      assert.ok(preview.issues.some(issue => issue.severity === "info" && issue.message.includes("Animated texture metadata")));
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
      assert.ok(preview.issues.some(issue => issue.severity === "warning" && issue.message.includes("Parent model not found")));
      assert.ok(preview.issues.some(issue => issue.severity === "warning" && issue.message.includes("Texture variable not found")));
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

      assert.ok(preview.issues.some(issue => issue.severity === "error" && issue.message.includes("Parent model cycle")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("uses default assets as a fallback for parent models", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const defaultAssets = path.join(root, "default");
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
      assert.ok(preview.dependencies.some(dependency => dependency.uri.includes("/default/") || dependency.uri.includes("%5Cdefault%5C")));
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

  it("generates a simplified plane for item/generated", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/item/apple.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "minecraft:item/apple"
        }
      });
      writeFile(pack, "assets/minecraft/textures/item/apple.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/item/apple.json"));

      assert.strictEqual(preview.meshes.length, 1);
      assert.strictEqual(preview.meshes[0].faces.length, 6);
      assert.ok(preview.issues.some(issue => issue.severity === "info" && issue.message.includes("Generated item model")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("bakes default UVs and face rotation", () => {
    assert.deepStrictEqual(getDefaultUv("down", [1, 2, 3], [4, 5, 6]), [1, 10, 4, 13]);
    assert.deepStrictEqual(getDefaultUv("north", [1, 2, 3], [4, 5, 6]), [12, 11, 15, 14]);
    assert.deepStrictEqual(getFaceUvs([0, 0, 16, 16], 90), [[16, 16], [0, 16], [0, 0], [16, 0]]);
  });

  it("applies element rotation to baked face positions", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/rotated.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            rotation: {
              origin: [8, 8, 8],
              axis: "y",
              angle: 90
            },
            faces: { north: { texture: "#all" } }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/stone.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/rotated.json"));
      const positions = preview.meshes[0].faces[0].positions;

      assert.ok(positions.some(position => Math.abs(position[0]) < 0.000001));
      assert.ok(positions.some(position => Math.abs(position[2] - 16) < 0.000001));
    } finally {
      removeTempDirectory(root);
    }
  });

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
});

function createService(configuration = {}) {
  return new ModelPreviewService({
    configuration: () => configuration
  });
}

function createPack(root: string, name: string): string {
  const pack = path.join(root, name);
  writeJson(pack, "pack.mcmeta", {
    pack: {
      ["min_format"]: [88, 0],
      ["max_format"]: [88, 0],
      description: "test"
    }
  });
  return pack;
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  writeFile(root, relativePath, JSON.stringify(value, null, 2));
}

function writeFile(root: string, relativePath: string, value: string): void {
  const fileName = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, value);
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-preview-"));
}

function removeTempDirectory(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
