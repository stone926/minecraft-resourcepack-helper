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
});

function createJsonDocument(fileName: string, value: unknown): ResourceReferenceDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}
