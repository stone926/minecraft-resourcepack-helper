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

  it("extracts post effect shader references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "post_effect", "blur.json"),
      {
        targets: {
          swap: {}
        },
        passes: [
          {
            ["vertex_shader"]: "minecraft:core/screenquad",
            ["fragment_shader"]: "minecraft:post/box_blur",
            inputs: [
              {
                ["sampler_name"]: "In",
                target: "minecraft:main"
              }
            ],
            output: "swap"
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["shader", "minecraft:core/screenquad", "shaders", "vsh"],
        ["shader", "minecraft:post/box_blur", "shaders", "fsh"]
      ]
    );
  });

  it("extracts model and base model references from item model definitions", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "items", "shield.json"),
      {
        model: {
          type: "minecraft:condition",
          ["on_false"]: {
            type: "minecraft:special",
            base: "minecraft:item/shield",
            model: {
              type: "minecraft:shield"
            }
          },
          ["on_true"]: {
            type: "minecraft:model",
            model: "minecraft:item/shield_blocking"
          }
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:item/shield", "models", "items", "json"],
        ["model", "minecraft:item/shield_blocking", "models", "items", "json"]
      ]
    );
  });

  it("extracts sound file references and skips sound event references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "custom", "sounds.json"),
      {
        ["entity.example.ambient"]: {
          replace: true,
          subtitle: "subtitles.entity.example.ambient",
          sounds: [
            "custom:entity/example/ambient1",
            {
              name: "custom:entity/example/ambient2",
              volume: 0.8,
              pitch: 1.1
            },
            {
              name: "custom:entity/example/variant",
              type: "file",
              weight: 2
            },
            {
              name: "custom:entity.example.other",
              type: "event"
            }
          ]
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["sound", "custom:entity/example/ambient1", "sounds", "sounds.json", "ogg"],
        ["sound", "custom:entity/example/ambient2", "sounds", "sounds.json", "ogg"],
        ["sound", "custom:entity/example/variant", "sounds", "sounds.json", "ogg"]
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
