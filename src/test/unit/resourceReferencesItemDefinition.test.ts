import * as assert from "node:assert/strict";
import * as path from "node:path";
import { createJsonDocument } from "./helpers/documents";
import { getResourceReferences } from "./helpers/resourceReferences";

describe("item model definition resource references", () => {
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
});
