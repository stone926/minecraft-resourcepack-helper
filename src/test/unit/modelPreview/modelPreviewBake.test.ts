import * as assert from "node:assert/strict";
import * as path from "node:path";
import { getDefaultUv, getFaceUvs } from "../../../../packages/mc-assets/src/modelGeometry";
import type { PreviewFace, PreviewVec3 } from "../../../modelPreview/ir/PreviewDocument";
import { createPack, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "../helpers/tempPack";
import { createService } from "./previewServiceTestSupport";

describe("model preview UV and bake math", () => {
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
});

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
