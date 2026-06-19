import * as assert from "node:assert";
import * as path from "node:path";
import { getResourceReferences, ResourceReferenceDocument } from "../../utils/resourceReferences";

describe("resource references", () => {
  it("skips unrelated JSON documents without reading their contents", () => {
    const document: ResourceReferenceDocument = {
      languageId: "json",
      fileName: path.join("pack", "package.json"),
      getText: () => {
        throw new Error("Unrelated JSON should not be parsed");
      }
    };

    assert.deepStrictEqual(getResourceReferences(document), []);
  });

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

  it("keeps empty string resource references so completion can start from blank values", () => {
    const variants: Record<string, { model: string }> = {};
    variants[""] = { model: "" };

    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "blockstates", "empty.json"),
      {
        variants
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "", "models", "blockstates", "json"]
      ]
    );
  });

  it("extracts object model texture sprite references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "custom_glass.json"),
      {
        parent: "minecraft:block/cube_all",
        textures: {
          all: {
            sprite: "minecraft:block/custom_glass",
            ["force_translucent"]: true
          },
          particle: "#all"
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:block/cube_all", "models", "models/block", "json"],
        ["texture", "minecraft:block/custom_glass", "textures", "models/block", "png"],
        ["texture", "#all", "textures", "models/block", "png"]
      ]
    );
  });

  it("marks only parent model references as inheritance relationships", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "item", "custom.json"),
      {
        parent: "minecraft:item/generated",
        overrides: [
          {
            predicate: {
              ["custom_model_data"]: 1
            },
            model: "minecraft:item/custom_variant"
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.value, reference.relationship ?? null]),
      [
        ["minecraft:item/generated", "modelParent"],
        ["minecraft:item/custom_variant", null]
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

  it("extracts font references and provider file references", () => {
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
          },
          {
            type: "ttf",
            file: "example:custom.ttf"
          },
          {
            type: "unihex",
            ["hex_file"]: "example:unifont.hex"
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension]),
      [
        ["font", "minecraft:include/space", "font", "json"],
        ["texture", "minecraft:font/ascii.png", "textures", "png"],
        ["fontFile", "example:custom.ttf", "font", null],
        ["fontFile", "example:unifont.hex", "font", null]
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
              },
              {
                ["sampler_name"]: "Mask",
                location: "minecraft:blur/mask",
                width: 16,
                height: 16
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
        ["shader", "minecraft:post/box_blur", "shaders", "fsh"],
        ["texture", "minecraft:blur/mask", "textures/effect", "png"]
      ]
    );
  });

  it("extracts shader import references", () => {
    const coreDocument = createTextDocument(
      path.join("pack", "assets", "minecraft", "shaders", "core", "entity.vsh"),
      [
        "#version 330",
        "#moj_import <light.glsl>",
        "#moj_import <custom:lighting/fog.vsh>",
        "#moj_import \"custom:shared/fog.glsl\"",
        "#moj_import \"screenquad.glsl\""
      ].join("\n")
    );
    const postDocument = createTextDocument(
      path.join("pack", "assets", "minecraft", "shaders", "post", "box_blur.fsh"),
      "#moj_import <post_effect/common.fsh>"
    );

    const references = [
      ...getResourceReferences(coreDocument),
      ...getResourceReferences(postDocument)
    ];

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["shader", "light.glsl", "shaders/include", "shaders/core", null],
        ["shader", "custom:lighting/fog.vsh", "shaders/include", "shaders/core", null],
        ["shader", "custom:shared/fog.glsl", "shaders/include", "shaders/core", null],
        ["shader", "screenquad.glsl", "shaders/core", "shaders/core", null],
        ["shader", "post_effect/common.fsh", "shaders/include", "shaders/post", null]
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

  it("extracts special item model texture references", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "items", "special.json"),
      {
        model: {
          type: "minecraft:select",
          cases: [
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/chest",
                model: {
                  type: "minecraft:chest",
                  texture: "minecraft:christmas"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/bell",
                model: {
                  type: "minecraft:bell"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/enchanted_book",
                model: {
                  type: "minecraft:book",
                  ["open_angle"]: 90,
                  page1: 0.25,
                  page2: 0.75
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/black_shulker_box",
                model: {
                  type: "minecraft:shulker_box",
                  texture: "minecraft:shulker_black"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/player_head",
                model: {
                  type: "minecraft:head",
                  kind: "player",
                  texture: "minecraft:skins/custom"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/conduit",
                model: {
                  type: "minecraft:conduit"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/end_portal",
                model: {
                  type: "minecraft:end_cube",
                  effect: "portal"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/player_head",
                model: {
                  type: "minecraft:player_head"
                }
              }
            },
            {
              model: {
                type: "minecraft:special",
                base: "minecraft:item/template_copper_golem_statue",
                model: {
                  type: "minecraft:copper_golem_statue",
                  pose: "standing",
                  texture: "minecraft:textures/entity/copper_golem/copper_golem.png"
                }
              }
            }
          ]
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:item/chest", "models", "items", "json"],
        ["texture", "minecraft:christmas", "textures/entity/chest", "items", "png"],
        ["model", "minecraft:item/bell", "models", "items", "json"],
        ["model", "minecraft:item/enchanted_book", "models", "items", "json"],
        ["model", "minecraft:item/black_shulker_box", "models", "items", "json"],
        ["texture", "minecraft:shulker_black", "textures/entity/shulker", "items", "png"],
        ["model", "minecraft:item/player_head", "models", "items", "json"],
        ["texture", "minecraft:skins/custom", "textures/entity", "items", "png"],
        ["model", "minecraft:item/conduit", "models", "items", "json"],
        ["model", "minecraft:item/end_portal", "models", "items", "json"],
        ["model", "minecraft:item/player_head", "models", "items", "json"],
        ["model", "minecraft:item/template_copper_golem_statue", "models", "items", "json"],
        ["texture", "minecraft:textures/entity/copper_golem/copper_golem.png", "", "items", "png"]
      ]
    );
  });

  it("does not resolve removed item special model textures", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "items", "removed_special.json"),
      {
        model: {
          type: "minecraft:composite",
          models: [
            {
              type: "minecraft:special",
              base: "minecraft:item/red_bed",
              model: {
                type: "minecraft:bed",
                part: "head",
                texture: "minecraft:red"
              }
            },
            {
              type: "minecraft:special",
              base: "minecraft:item/oak_sign",
              model: {
                type: "minecraft:standing_sign",
                ["wood_type"]: "oak",
                texture: "minecraft:custom_oak"
              }
            },
            {
              type: "minecraft:special",
              base: "minecraft:item/oak_hanging_sign",
              model: {
                type: "minecraft:hanging_sign",
                attachment: "ceiling",
                texture: "minecraft:custom_hanging"
              }
            }
          ]
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:item/red_bed", "models", "items", "json"],
        ["model", "minecraft:item/oak_sign", "models", "items", "json"],
        ["model", "minecraft:item/oak_hanging_sign", "models", "items", "json"]
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

function createTextDocument(fileName: string, text: string): ResourceReferenceDocument {
  return {
    languageId: "plaintext",
    fileName,
    getText: () => text
  };
}
