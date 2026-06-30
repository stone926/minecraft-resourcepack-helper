import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { getDefaultUv, getFaceUvs } from "../../../modelPreview/bake/DefaultUv";
import type { PreviewFace, PreviewVec3 } from "../../../modelPreview/ir/PreviewDocument";
import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewCancellationSource } from "../../../modelPreview/service/ModelPreviewCancellation";
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
      assert.ok(preview.issues.find(issue => issue.message.includes("Parent model not found"))?.range);
      assert.ok(preview.issues.find(issue => issue.message.includes("Texture variable not found"))?.range);
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
        issue.message.includes("could not be parsed") &&
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
        issue.message.includes("outside Minecraft's supported") &&
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

  it("generates item/generated layers like Minecraft", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/item/potion.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "minecraft:item/overlay",
          layer1: "minecraft:item/potion"
        }
      });
      writeFile(pack, "assets/minecraft/textures/item/overlay.png", createRgbaPng(2, 2, () => 0));
      writeFile(pack, "assets/minecraft/textures/item/potion.png", createRgbaPng(2, 2, () => 255));

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/item/potion.json"));
      const layer0Material = preview.materials.find(material => /overlay\.png/.test(material.textureUri ?? ""));
      const layer1Material = preview.materials.find(material => /potion\.png/.test(material.textureUri ?? ""));
      const faces = preview.meshes.flatMap(mesh => mesh.faces);
      const layer0Faces = faces.filter(face => face.materialId === layer0Material?.id);
      const layer1Faces = faces.filter(face => face.materialId === layer1Material?.id);

      assert.ok(layer0Material);
      assert.ok(layer1Material);
      assert.deepStrictEqual(layer0Faces.map(face => face.direction).sort(), ["north", "south"]);
      assert.strictEqual(layer1Faces.length, 10);
      assert.ok(layer1Faces.some(face => face.direction === "south" && face.tintindex === 1));
      assert.ok(layer1Faces.some(face => face.direction === "up"));
      assert.ok(layer1Faces.some(face => face.direction === "down"));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("extrudes item/generated sides from opaque texture transitions", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/item/single_pixel.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "minecraft:item/single_pixel",
          layer2: "minecraft:item/skipped"
        }
      });
      writeFile(pack, "assets/minecraft/textures/item/single_pixel.png", createRgbaPng(2, 2, (x, y) => x === 0 && y === 0 ? 255 : 0));
      writeFile(pack, "assets/minecraft/textures/item/skipped.png", createRgbaPng(2, 2, () => 255));

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/item/single_pixel.json"));
      const faces = preview.meshes.flatMap(mesh => mesh.faces);
      const sideDirections = faces
        .map(face => face.direction)
        .filter(direction => direction !== "north" && direction !== "south")
        .sort();

      assert.strictEqual(faces.length, 6);
      assert.deepStrictEqual(sideDirections, ["down", "east", "up", "west"]);
      assert.strictEqual(preview.materials.length, 1, "Minecraft stops generated layers at the first missing layer slot");
    } finally {
      removeTempDirectory(root);
    }
  });

  it("bakes default UVs and face rotation", () => {
    assert.deepStrictEqual(getDefaultUv("down", [1, 2, 3], [4, 5, 6]), [1, 10, 4, 13]);
    assert.deepStrictEqual(getDefaultUv("north", [1, 2, 3], [4, 5, 6]), [12, 11, 15, 14]);
    assert.deepStrictEqual(getFaceUvs([0, 0, 16, 16], 90), [[0, 16], [16, 16], [16, 0], [0, 0]]);
  });

  it("bakes negative cuboids with inward-facing front sides", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/negative.json", {
        textures: { wax: "minecraft:block/waxed_block" },
        elements: [
          {
            from: [17, 17, 17],
            to: [-1, -1, -1],
            shade: false,
            faces: {
              east: { texture: "#wax", uv: [0, 0, 16, 16] },
              north: { texture: "#wax", uv: [0, 0, 16, 16] }
            }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/waxed_block.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/negative.json"));
      const east = preview.meshes[0].faces.find(face => face.direction === "east");
      const north = preview.meshes[0].faces.find(face => face.direction === "north");

      assert.ok(east);
      assert.ok(north);
      assert.deepStrictEqual(east.positions, [
        [-1, 17, 17],
        [-1, -1, 17],
        [-1, -1, -1],
        [-1, 17, -1]
      ]);
      assert.ok(faceFrontNormal(east)[0] > 0);
      assert.ok(faceFrontNormal(north)[2] < 0);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("skips zero-thickness cuboid faces like Minecraft", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/block/flat.json", {
        textures: { all: "minecraft:block/stone" },
        elements: [
          {
            from: [8, 0, 0],
            to: [8, 16, 16],
            faces: {
              east: { texture: "#all" },
              west: { texture: "#all" },
              up: { texture: "#all" },
              down: { texture: "#all" },
              north: { texture: "#all" },
              south: { texture: "#all" }
            }
          }
        ]
      });
      writeFile(pack, "assets/minecraft/textures/block/stone.png", "png");

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/block/flat.json"));
      const directions = preview.meshes[0].faces.map(face => face.direction).sort();

      assert.deepStrictEqual(directions, ["east", "west"]);
    } finally {
      removeTempDirectory(root);
    }
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

function createService(configuration = {}, fileSystem?: ModelPreviewFileSystem) {
  return new ModelPreviewService({
    configuration: () => configuration,
    fileSystem
  });
}

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

function writeFile(root: string, relativePath: string, value: string | Uint8Array): void {
  const fileName = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, value);
}

function createRgbaPng(width: number, height: number, alphaAt: (x: number, y: number) => number): Buffer {
  const rowStride = width * 4 + 1;
  const rows = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    rows[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const offset = rowOffset + 1 + x * 4;
      rows[offset] = 255;
      rows[offset + 1] = 255;
      rows[offset + 2] = 255;
      rows[offset + 3] = alphaAt(x, y);
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      8,
      6,
      0,
      0,
      0
    ])),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-preview-"));
}

function removeTempDirectory(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function faceFrontNormal(face: PreviewFace): PreviewVec3 {
  const [a, b, c] = [face.positions[0], face.positions[1], face.positions[2]];
  return cross(subtract(b, a), subtract(c, a));
}

function subtract(left: PreviewVec3, right: PreviewVec3): PreviewVec3 {
  return [
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2]
  ];
}

function cross(left: PreviewVec3, right: PreviewVec3): PreviewVec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}
