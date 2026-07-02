import * as assert from "node:assert";
import * as path from "node:path";
import {
  findResourceReferenceAtPosition,
  getResourceReferences,
  ResourceReferenceDocument
} from "../../utils/resourceReferences";
import { getCitAutoDiscoveryPathCandidates } from "../../utils/citPaths";

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

  it("keeps empty model texture references findable for completion", () => {
    const text = [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"side\": \"\"",
      "  }",
      "}"
    ].join("\n");
    const document = createTextDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "empty_texture.json"),
      text,
      "json"
    );

    const references = getResourceReferences(document);
    const referenceAtBlankValue = findResourceReferenceAtPosition(document, { line: 3, character: 13 });

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:block/cube_all", "models", "models/block", "json"],
        ["texture", "", "textures", "models/block", "png"]
      ]
    );
    assert.strictEqual(referenceAtBlankValue?.kind, "texture");
    assert.strictEqual(referenceAtBlankValue.value, "");
  });

  it("finds explicit namespace model texture references from cached references", () => {
    const { document, position, getTextCallCount } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "models", "block", "explicit_namespace_texture.json"),
      [
        "{",
        "  \"parent\": \"minecraft:block/cube_all\",",
        "  \"textures\": {",
        "    \"all\": \"minecraft:|\"",
        "  }",
        "}"
      ].join("\n"),
      "json",
      1
    );

    const references = getResourceReferences(document);
    const referenceAtNamespace = findResourceReferenceAtPosition(document, position);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:block/cube_all", "models", "models/block", "json"],
        ["texture", "minecraft:", "textures", "models/block", "png"]
      ]
    );
    assert.strictEqual(referenceAtNamespace?.kind, "texture");
    assert.strictEqual(referenceAtNamespace.value, "minecraft:");
    assert.strictEqual(getTextCallCount(), 1);
  });

  it("extracts references from models outside block and item folders", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "models", "custom", "machine.json"),
      {
        parent: "minecraft:custom/base",
        textures: {
          all: "minecraft:block/iron_block"
        }
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension]),
      [
        ["model", "minecraft:custom/base", "models", "models", "json"],
        ["texture", "minecraft:block/iron_block", "textures", "models", "png"]
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

  it("extracts CIT texture and model references from properties files", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "custom", "citresewn", "cit", "swords", "emerald.properties"),
      [
        "# example CIT",
        "type=item",
        "items=minecraft:diamond_sword",
        "texture.layer0 = ./textures/emerald|_sword",
        "model.bow_pulling_2=custom:item/emerald_bow"
      ].join("\n"),
      "properties",
      1
    );

    const references = getResourceReferences(document);
    const referenceAtTexture = findResourceReferenceAtPosition(document, position);

    assert.deepStrictEqual(
      references.map(reference => [
        reference.kind,
        reference.value,
        reference.target,
        reference.source,
        reference.extension,
        reference.resolveMode ?? null
      ]),
      [
        ["texture", "./textures/emerald_sword", "textures", "citresewn/cit/swords", "png", "cit"],
        ["model", "custom:item/emerald_bow", "models", "citresewn/cit/swords", "json", "cit"]
      ]
    );
    assert.strictEqual(referenceAtTexture?.value, "./textures/emerald_sword");
  });

  it("keeps empty CIT asset references findable for completion", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "optifine", "cit", "swords", "empty.properties"),
      "texture=|",
      "properties",
      1
    );

    const references = getResourceReferences(document);
    const referenceAtBlankValue = findResourceReferenceAtPosition(document, position);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension, reference.resolveMode ?? null]),
      [
        ["texture", "", "textures", "optifine/cit/swords", "png", "cit"]
      ]
    );
    assert.strictEqual(referenceAtBlankValue?.kind, "texture");
    assert.strictEqual(referenceAtBlankValue.value, "");
  });

  it("finds CIT asset references when the cursor is at the end of the value", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "optifine", "cit", "axolotl_bucket", "purple_small.properties"),
      "model=minecraft:item/axolotl_bucket/purple_s|",
      "properties",
      1
    );

    const referenceAtValueEnd = findResourceReferenceAtPosition(document, position);

    assert.strictEqual(referenceAtValueEnd?.kind, "model");
    assert.strictEqual(referenceAtValueEnd.value, "minecraft:item/axolotl_bucket/purple_s");
  });

  it("adds synthetic CIT auto-discovery references for item CIT without explicit assets", () => {
    const document = createTextDocument(
      path.join("pack", "assets", "minecraft", "citresewn", "cit", "stuff", "my_cool_stick.properties"),
      [
        "type=item",
        "items=stick",
        "nbt.CustomModelData=1"
      ].join("\n"),
      "properties"
    );

    const references = getResourceReferences(document);
    const referenceAtDocumentStart = findResourceReferenceAtPosition(document, { line: 0, character: 0 });

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.extension, reference.origin ?? null, reference.synthetic ?? false]),
      [
        ["model", "my_cool_stick", "models", "json", "citAutoDiscovery", true]
      ]
    );
    assert.strictEqual(referenceAtDocumentStart, null);
  });

  it("orders CIT auto-discovery model candidates before texture candidates", () => {
    const documentFileName = path.join("pack", "assets", "minecraft", "citresewn", "cit", "stuff", "my_cool_stick.properties");

    const candidates = getCitAutoDiscoveryPathCandidates(documentFileName, "pack", "my_cool_stick");

    assert.deepStrictEqual(candidates.slice(0, 2), [
      path.join("pack", "assets", "minecraft", "citresewn", "cit", "stuff", "my_cool_stick.json"),
      path.join("pack", "assets", "minecraft", "models", "my_cool_stick.json")
    ]);
    assert.ok(candidates.indexOf(path.join("pack", "assets", "minecraft", "citresewn", "cit", "stuff", "my_cool_stick.json")) <
      candidates.indexOf(path.join("pack", "assets", "minecraft", "citresewn", "cit", "stuff", "my_cool_stick.png")));
  });

  it("extracts CIT local model JSON references with CIT resolve mode", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "optifine", "cit", "swords", "emerald.json"),
      [
        "{",
        "  \"parent\": \"./base\",",
        "  \"textures\": {",
        "    \"layer0\": \"./textures/emerald|\"",
        "  },",
        "  \"overrides\": [",
        "    { \"predicate\": { \"pulling\": 1 }, \"model\": \"./pulling\" }",
        "  ]",
        "}"
      ].join("\n"),
      "json",
      1
    );

    const references = getResourceReferences(document);
    const referenceAtTexture = findResourceReferenceAtPosition(document, position);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension, reference.relationship ?? null, reference.resolveMode ?? null]),
      [
        ["model", "./base", "models", "optifine/cit/swords", "json", "modelParent", "cit"],
        ["texture", "./textures/emerald", "textures", "optifine/cit/swords", "png", null, "cit"],
        ["model", "./pulling", "models", "optifine/cit/swords", "json", null, "cit"]
      ]
    );
    assert.strictEqual(referenceAtTexture?.value, "./textures/emerald");
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

  it("treats selected item models and special models without base as leaves", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "items", "selected.json"),
      {
        model: {
          type: "minecraft:composite",
          models: [
            {
              type: "minecraft:selected_item"
            },
            {
              type: "minecraft:special",
              model: {
                type: "minecraft:shield"
              }
            }
          ]
        }
      }
    );

    assert.deepStrictEqual(getResourceReferences(document), []);
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

function createTextDocument(fileName: string, text: string, languageId = "plaintext"): ResourceReferenceDocument {
  return {
    languageId,
    fileName,
    getText: () => text
  };
}

function createMarkedTextDocument(
  fileName: string,
  markedText: string,
  languageId: string,
  version: number
): {
    document: ResourceReferenceDocument;
    position: { line: number; character: number };
    getTextCallCount: () => number;
  } {
  const markerOffset = markedText.indexOf("|");
  assert.notStrictEqual(markerOffset, -1);

  const text = `${markedText.slice(0, markerOffset)}${markedText.slice(markerOffset + 1)}`;
  const textBeforeMarker = markedText.slice(0, markerOffset);
  const linesBeforeMarker = textBeforeMarker.split("\n");
  let getTextCallCount = 0;

  return {
    document: {
      languageId,
      fileName,
      version,
      getText: () => {
        getTextCallCount++;
        return text;
      }
    },
    position: {
      line: linesBeforeMarker.length - 1,
      character: linesBeforeMarker[linesBeforeMarker.length - 1].length
    },
    getTextCallCount: () => getTextCallCount
  };
}
