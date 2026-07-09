import * as assert from "node:assert";
import * as path from "node:path";
import type { ResolvedModel } from "../../../modelPreview/model/ModelDocument";
import { ModelIssueCollector } from "../../../modelPreview/model/ModelIssues";
import { ModelPreviewCancellationSource } from "../../../modelPreview/cancellation";
import { createGeneratedItemElements, type GeneratedItemTextureResolver } from "../../../modelPreview/bake/GeneratedItemModel";
import type { PngAlphaMask } from "../../../modelPreview/bake/AlphaMask";
import { createPack, createRgbaPng, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "../helpers/tempPack";
import { createService } from "./previewServiceTestSupport";

describe("model preview generated item and CIT previews", () => {
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
      assert.strictEqual(layer1Faces.length, 6);
      assert.ok(layer1Faces.some(face => face.direction === "south" && face.tintindex === 1));
      assert.ok(layer1Faces.some(face => face.direction === "up"));
      assert.ok(layer1Faces.some(face => face.direction === "down"));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("previews CIT item texture-only properties as generated item models", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const properties = path.join(pack, "assets/minecraft/citresewn/cit/stick.properties");
      writeFile(pack, "assets/minecraft/citresewn/cit/stick.properties", [
        "type=item",
        "items=stick",
        "texture=./stick"
      ].join("\n"));
      writeFile(pack, "assets/minecraft/citresewn/cit/stick.png", createRgbaPng(2, 2, () => 255));

      const preview = await createService().getPreviewDocument(properties);

      assert.ok(preview.meshes.length > 0);
      assert.match(preview.materials[0].textureUri ?? "", /stick\.png$/);
      assert.ok(preview.dependencies.some(dependency => dependency.uri.endsWith("stick.properties")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("previews CIT item model plus texture replacement", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const properties = path.join(pack, "assets/minecraft/citresewn/cit/custom.properties");
      writeFile(pack, "assets/minecraft/citresewn/cit/custom.properties", [
        "type=item",
        "items=stick",
        "model=./custom_model",
        "texture=./replacement"
      ].join("\n"));
      writeJson(pack, "assets/minecraft/citresewn/cit/custom_model.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "./original"
        }
      });
      writeFile(pack, "assets/minecraft/citresewn/cit/original.png", createRgbaPng(2, 2, () => 255));
      writeFile(pack, "assets/minecraft/citresewn/cit/replacement.png", createRgbaPng(2, 2, () => 255));

      const preview = await createService().getPreviewDocument(properties);

      assert.ok(preview.meshes.length > 0);
      assert.match(preview.materials[0].textureUri ?? "", /replacement\.png$/);
      assert.strictEqual(preview.materials.some(material => /original\.png/.test(material.textureUri ?? "")), false);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("previews armor, elytra, and enchantment CIT textures", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const cases = [
        {
          file: "armor.properties",
          properties: ["type=armor", "items=diamond_helmet", "texture.layer_1=./armor"].join("\n"),
          texture: "armor.png"
        },
        {
          file: "elytra.properties",
          properties: ["type=elytra", "texture=./elytra"].join("\n"),
          texture: "elytra.png"
        },
        {
          file: "glint.properties",
          properties: ["type=enchantment", "texture=./glint", "blend=add"].join("\n"),
          texture: "glint.png"
        }
      ];

      for (const item of cases) {
        const properties = path.join(pack, "assets/minecraft/citresewn/cit", item.file);
        writeFile(pack, `assets/minecraft/citresewn/cit/${item.file}`, item.properties);
        writeFile(pack, `assets/minecraft/citresewn/cit/${item.texture}`, createRgbaPng(2, 2, () => 255));

        const preview = await createService().getPreviewDocument(properties);

        assert.ok(preview.meshes.length > 0, item.file);
        assert.match(preview.materials[0].textureUri ?? "", new RegExp(item.texture.replace(".", "\\.")));
      }
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

  it("simplifies oversized item/generated side extrusion", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/minecraft/models/item/checker.json", {
        parent: "minecraft:item/generated",
        textures: {
          layer0: "minecraft:item/checker"
        }
      });
      writeFile(pack, "assets/minecraft/textures/item/checker.png", createRgbaPng(257, 257, (x, y) => (x + y) % 2 === 0 ? 255 : 0));

      const preview = await createService().getPreviewDocument(path.join(pack, "assets/minecraft/models/item/checker.json"));
      const faces = preview.meshes.flatMap(mesh => mesh.faces);

      assert.strictEqual(faces.length, 6);
      assert.ok(preview.issues.some(issue => issue.message.message.includes("side extrusion is simplified")));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("cancels item/generated side extrusion while scanning alpha", async () => {
    const cancellation = new ModelPreviewCancellationSource();
    let reads = 0;
    const alphaMask: PngAlphaMask = {
      width: 16,
      height: 16,
      isOpaque() {
        reads++;
        if (reads === 8) {
          cancellation.cancel();
        }
        return true;
      }
    };

    await assert.rejects(
      createGeneratedItemElements(
        createGeneratedModel(),
        createTextureResolverStub("large.png"),
        new ModelIssueCollector(),
        async () => alphaMask,
        cancellation.token
      ),
      /cancelled/i
    );
  });
});

function createGeneratedModel(): ResolvedModel {
  return {
    fileName: path.resolve("virtual-pack/assets/minecraft/models/item/generated.json"),
    resourceId: "minecraft:item/generated",
    generatedItem: true,
    textures: {
      layer0: {
        name: "layer0",
        value: "minecraft:item/generated",
        sourceModelFileName: path.resolve("virtual-pack/assets/minecraft/models/item/generated.json")
      }
    },
    elements: [],
    display: {},
    dependencies: []
  };
}

function createTextureResolverStub(textureFileName: string): GeneratedItemTextureResolver {
  return {
    resolve: () => ({
      textureFileName
    })
  };
}
