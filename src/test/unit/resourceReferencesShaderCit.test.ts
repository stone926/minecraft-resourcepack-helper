import * as assert from "node:assert/strict";
import * as path from "node:path";
import { getCitAutoDiscoveryPathCandidates } from "../../cit/citPaths";
import { registerCitResourceReferenceExtractor } from "../../cit/registerCitResourceReferences";
import { createJsonDocument, createMarkedTextDocument, createTextDocument } from "./helpers/documents";
import { findResourceReferenceAtPosition, getResourceReferences } from "./helpers/resourceReferences";

describe("shader and CIT resource references", () => {
  const citReferences = registerCitResourceReferenceExtractor();
  after(() => citReferences.dispose());

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
        ["shader", "custom:shared/fog.glsl", "shaders/core", "shaders/core", null],
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

  it("extracts CIT assets through aliases and default-namespaced keys", () => {
    const document = createMarkedTextDocument(
      path.join("pack", "assets", "custom", "citresewn", "cit", "swords", "namespaced.properties"),
      [
        "citresewn:type=item",
        "tile=./textures/ali|as",
        "citresewn:texture=./textures/namespaced",
        "model.bow_standby=custom:item/bow"
      ].join("\n"),
      "properties",
      1
    ).document;

    const references = getResourceReferences(document);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target]),
      [
        ["texture", "./textures/alias", "textures"],
        ["texture", "./textures/namespaced", "textures"],
        ["model", "custom:item/bow", "models"]
      ]
    );
  });

  it("finds shader imports at the end of their value", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "shaders", "core", "entity.vsh"),
      "#moj_import <minecraft:lighting/fog|>",
      "glsl",
      1
    );

    const reference = findResourceReferenceAtPosition(document, position);

    assert.strictEqual(reference?.value, "minecraft:lighting/fog");
    assert.strictEqual(reference?.target, "shaders/include");
  });

  it("keeps empty closed shader imports findable without synthesizing another delimiter", () => {
    const angle = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "shaders", "core", "empty.vsh"),
      "#moj_import <|>",
      "glsl",
      1
    );
    const quoted = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "shaders", "core", "empty.fsh"),
      "#moj_import \"|\"",
      "glsl",
      1
    );

    assert.strictEqual(findResourceReferenceAtPosition(angle.document, angle.position)?.value, "");
    assert.strictEqual(findResourceReferenceAtPosition(quoted.document, quoted.position)?.value, "");
  });

  it("resolves quoted imports relative to nested post and include sources", () => {
    const postDocument = createTextDocument(
      path.join("pack", "assets", "custom", "shaders", "post", "nested", "blur.fsh"),
      "#moj_import \"../shared/common.glsl\""
    );
    const includeDocument = createTextDocument(
      path.join("pack", "assets", "custom", "shaders", "include", "lighting", "fog.glsl"),
      "#moj_import \"../math.glsl\""
    );

    const references = [
      ...getResourceReferences(postDocument),
      ...getResourceReferences(includeDocument)
    ];

    assert.deepStrictEqual(
      references.map(reference => [
        reference.value,
        reference.target,
        reference.source,
        reference.resolveMode ?? null
      ]),
      [
        ["../shared/common.glsl", "shaders/post/nested", "shaders/post/nested", "relative"],
        ["../math.glsl", "shaders/include/lighting", "shaders/include/lighting", "relative"]
      ]
    );
  });

  it("keeps empty CIT asset references findable for completion", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "citresewn", "cit", "swords", "empty.properties"),
      "texture=|",
      "properties",
      1
    );

    const references = getResourceReferences(document);
    const referenceAtBlankValue = findResourceReferenceAtPosition(document, position);

    assert.deepStrictEqual(
      references.map(reference => [reference.kind, reference.value, reference.target, reference.source, reference.extension, reference.resolveMode ?? null]),
      [
        ["texture", "", "textures", "citresewn/cit/swords", "png", "cit"]
      ]
    );
    assert.strictEqual(referenceAtBlankValue?.kind, "texture");
    assert.strictEqual(referenceAtBlankValue.value, "");
  });

  it("finds CIT asset references when the cursor is at the end of the value", () => {
    const { document, position } = createMarkedTextDocument(
      path.join("pack", "assets", "minecraft", "citresewn", "cit", "axolotl_bucket", "purple_small.properties"),
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
      path.join("pack", "assets", "minecraft", "citresewn", "cit", "swords", "emerald.json"),
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
        ["model", "./base", "models", "citresewn/cit/swords", "json", "modelParent", "cit"],
        ["texture", "./textures/emerald", "textures", "citresewn/cit/swords", "png", null, "cit"],
        ["model", "./pulling", "models", "citresewn/cit/swords", "json", null, "cit"]
      ]
    );
    assert.strictEqual(referenceAtTexture?.value, "./textures/emerald");
  });
});
