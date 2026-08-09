import * as assert from "node:assert";
import * as path from "node:path";
import { createJsonDocument } from "./helpers/documents";
import { getResourceReferences, type ResourceReferenceDocument } from "./helpers/resourceReferences";

describe("asset JSON resource references", () => {
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
