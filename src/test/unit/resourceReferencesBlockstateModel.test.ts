import * as assert from "node:assert";
import * as path from "node:path";
import { findResourceReferenceAtPosition, getResourceReferences } from "../../utils/resourceReferences";
import { createJsonDocument, createMarkedTextDocument, createTextDocument } from "./helpers/documents";

describe("blockstate and model resource references", () => {
  it("extracts object and array model choices from variants and multipart entries", () => {
    const document = createJsonDocument(
      path.join("pack", "assets", "minecraft", "blockstates", "model_choices.json"),
      {
        variants: {
          ["facing=north"]: {
            model: "minecraft:block/north"
          },
          ["facing=south"]: [
            { model: "minecraft:block/south" },
            { model: "minecraft:block/south_mirrored" }
          ]
        },
        multipart: [
          {
            apply: {
              model: "minecraft:block/overlay"
            }
          },
          {
            apply: [
              { model: "minecraft:block/overlay_a" },
              { model: "minecraft:block/overlay_b" }
            ]
          }
        ]
      }
    );

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.value, reference.target, reference.source, reference.extension]),
      [
        ["minecraft:block/north", "models", "blockstates", "json"],
        ["minecraft:block/south", "models", "blockstates", "json"],
        ["minecraft:block/south_mirrored", "models", "blockstates", "json"],
        ["minecraft:block/overlay", "models", "blockstates", "json"],
        ["minecraft:block/overlay_a", "models", "blockstates", "json"],
        ["minecraft:block/overlay_b", "models", "blockstates", "json"]
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
});
