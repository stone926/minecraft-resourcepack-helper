import * as assert from "node:assert/strict";
import * as path from "node:path";
import { createJsonDocument } from "./helpers/documents";
import { getResourceReferences } from "./helpers/resourceReferences";

describe("atlas resource references", () => {
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
            type: "minecraft:unstitch",
            resource: "minecraft:gui/container/legacy",
            ["divisor_x"]: 16,
            ["divisor_y"]: 16,
            regions: [
              {
                sprite: "minecraft:gui/container/slice",
                x: 0,
                y: 0,
                width: 16,
                height: 16
              }
            ]
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
        ["texture", "minecraft:gui/container/legacy", "textures", "png"],
        ["texture", "minecraft:trims/color_palettes/trim_palette", "textures", "png"],
        ["texture", "minecraft:trims/color_palettes/amethyst", "textures", "png"],
        ["texture", "minecraft:trims/items/helmet_trim", "textures", "png"]
      ]
    );
  });

  it("extracts unnamespaced single and unstitch sources through the same resource path", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "atlases", "unnamespaced.json"),
      {
        sources: [
          {
            type: "single",
            resource: "minecraft:block/stone"
          },
          {
            type: "unstitch",
            resource: "minecraft:gui/sprites/widget/button"
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["texture", "minecraft:block/stone", "textures", "png"],
        ["texture", "minecraft:gui/sprites/widget/button", "textures", "png"]
      ]
    );
  });
});
