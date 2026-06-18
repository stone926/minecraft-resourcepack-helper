import * as assert from "node:assert";
import * as path from "node:path";
import { getResourceReferences, ResourceReferenceDocument } from "../../utils/resourceReferences";

describe("resource references", () => {
  it("extracts atlas texture file and directory references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "atlases", "blocks.json"),
      {
        sources: [
          {
            type: "minecraft:directory",
            prefix: "block/",
            source: "block"
          },
          {
            type: "minecraft:single",
            resource: "minecraft:entity/bell/bell_body"
          },
          {
            type: "minecraft:paletted_permutations",
            ["palette_key"]: "minecraft:trims/color_palettes/trim_palette",
            permutations: {
              amethyst: "minecraft:trims/color_palettes/amethyst"
            },
            textures: [
              "minecraft:trims/items/helmet_trim"
            ]
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["textureDirectory", "block", "textures", null],
        ["texture", "minecraft:entity/bell/bell_body", "textures", "png"],
        ["texture", "minecraft:trims/color_palettes/trim_palette", "textures", "png"],
        ["texture", "minecraft:trims/color_palettes/amethyst", "textures", "png"],
        ["texture", "minecraft:trims/items/helmet_trim", "textures", "png"]
      ]
    );
  });

  it("extracts equipment layer texture references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "equipment", "armadillo_scute.json"),
      {
        layers: {
          ["wolf_body"]: [
            {
              texture: "minecraft:armadillo_scute"
            },
            {
              dyeable: {},
              texture: "minecraft:armadillo_scute_overlay"
            }
          ]
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["texture", "minecraft:armadillo_scute", "textures/entity/equipment/wolf_body", "png"],
        ["texture", "minecraft:armadillo_scute_overlay", "textures/entity/equipment/wolf_body", "png"]
      ]
    );
  });

  it("extracts font reference and bitmap file references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "font", "default.json"),
      {
        providers: [
          {
            type: "reference",
            id: "minecraft:include/space"
          },
          {
            type: "bitmap",
            file: "minecraft:font/ascii.png"
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["font", "minecraft:include/space", "font", "json"],
        ["texture", "minecraft:font/ascii.png", "textures", "png"]
      ]
    );
  });

  it("extracts waypoint locator sprite references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "waypoint_style", "default.json"),
      {
        sprites: [
          "minecraft:default_0",
          "minecraft:default_1"
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["texture", "minecraft:default_0", "textures/gui/sprites/hud/locator_bar_dot", "png"],
        ["texture", "minecraft:default_1", "textures/gui/sprites/hud/locator_bar_dot", "png"]
      ]
    );
  });
});

function createJsonDocument(fileName: string, value: unknown): ResourceReferenceDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}
