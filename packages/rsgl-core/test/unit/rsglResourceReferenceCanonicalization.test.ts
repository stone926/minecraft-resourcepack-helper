import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonValue } from "../../src/compiler";
import {
  canonicalizeResourceReference,
  resourceReferenceConsumers
} from "../../src/compiler/resourceReferenceConsumers";
import { compileSource, expectNoDiagnostics, generatedResourceUnits, unitByPath } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL resource reference canonicalization", () => {
  it("canonicalizes generated model and texture sinks before resolution and emission", () => {
    const root = createTempDir("rsgl-reference-canonical-");
    try {
      fs.writeFileSync(path.join(root, "stone.png"), Buffer.from([1, 2, 3]));
      let externalLookupCount = 0;
      const result = compileSource([
        "namespace demo",
        "copy \"assets/demo/textures/block/stone.png\" { from \"stone.png\" }",
        "model block stone {",
        "  textures { all: block/stone }",
        "  elements [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: block/stone } } }]",
        "}",
        "blockstate stone {",
        "  variants { {} -> { model: block/stone } }",
        "}"
      ], {
        fileName: path.join(root, "main.rsgl"),
        externResourceExists: () => {
          externalLookupCount++;
          return true;
        }
      });

      expectNoDiagnostics(result);
      assert.strictEqual(externalLookupCount, 0);
      assert.ok(generatedResourceUnits(result).every(unit => !unit.external));
      assert.deepStrictEqual(unitByPath(result, "assets/demo/models/block/stone.json").content, {
        textures: { all: "demo:block/stone" },
        elements: [{
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: "demo:block/stone" } }
        }]
      });
      assert.deepStrictEqual(unitByPath(result, "assets/demo/blockstates/stone.json").content, {
        variants: { "": { model: "demo:block/stone" } }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit namespaces, texture variables, and generic JSON strings", () => {
    const result = compileSource([
      "namespace demo",
      "extern! custom model other:**",
      "extern! custom texture other:**",
      "model block child {",
      "  parent other:block/parent",
      "  textures { all: \"#side\", side: other:block/side }",
      "}",
      "json demo:config/raw {",
      "  model \"block/raw\"",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "assets/demo/models/block/child.json").content, {
      parent: "other:block/parent",
      textures: { all: "#side", side: "other:block/side" }
    });
    assert.deepStrictEqual(unitByPath(result, "assets/demo/config/raw.json").content, {
      model: "block/raw"
    });
  });

  it("rejects invalid references without querying extern or disk resolution", () => {
    let resolverCalls = 0;
    const result = compileSource([
      "namespace demo",
      "extern! custom model *:**",
      "blockstate invalid {",
      "  variants { {} -> { model: \"Bad Model\" } }",
      "}"
    ], {
      externResourceExists: () => {
        resolverCalls++;
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.invalidResourceReference"
    ]);
    assert.strictEqual(resolverCalls, 0);
    assert.ok(result.diagnostics[0].range.end > result.diagnostics[0].range.start);
  });

  it("routes empty known-sink values through invalid reference diagnostics", () => {
    let resolverCalls = 0;
    const result = compileSource([
      "extern! custom model minecraft:item/chest",
      "item empty_texture {",
      "  special base minecraft:item/chest model { type: minecraft:chest, texture: \"\" }",
      "}",
      "post_effect empty_references {",
      "  passes [{ vertex_shader: \"\", fragment_shader: \"\", inputs: [{ location: \"\" }] }]",
      "}",
      "waypoint_style empty_sprite {",
      "  sprites [\"\"]",
      "}"
    ], {
      externResourceExists: () => {
        resolverCalls++;
        return true;
      }
    });

    const invalidReferences = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidResourceReference"
    );
    assert.strictEqual(invalidReferences.length, 5);
    assert.strictEqual(result.diagnostics.length, 5);
    assert.strictEqual(resolverCalls, 0);
  });

  it("passes canonical IDs through custom-first extern and disk resolution", () => {
    const resolutionCalls: Array<{ source: string; id: string }> = [];
    const result = compileSource([
      "namespace demo",
      "blockstate external {",
      "  variants { {} -> { model: block/external } }",
      "}"
    ], {
      globalExterns: [
        { source: "vanilla", kind: "model", patterns: ["demo:**"] },
        { source: "custom", kind: "model", patterns: ["demo:**"] }
      ],
      externResourceExists: (source, _kind, id) => {
        resolutionCalls.push({ source, id });
        return true;
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(resolutionCalls, [{ source: "custom", id: "demo:block/external" }]);
    assert.deepStrictEqual(unitByPath(result, "assets/demo/blockstates/external.json").content, {
      variants: { "": { model: "demo:block/external" } }
    });
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id),
      ["demo:block/external"]
    );
  });

  it("canonicalizes atlas sprite IDs without resolving them as texture files", () => {
    const result = compileSource([
      "namespace demo",
      "extern! custom texture demo:block/sheet",
      "atlas blocks {",
      "  sources [",
      "    { type: \"minecraft:single\", resource: block/sheet, sprite: block/custom },",
      "    { type: \"minecraft:unstitch\", resource: block/sheet, sprite: \"block/unknown\", regions: [{ sprite: block/region, x: 0, y: 0, width: 1, height: 1 }] }",
      "  ]",
      "}"
    ]);

    expectNoDiagnostics(result);
    const content = unitByPath(result, "assets/demo/atlases/blocks.json").content as {
      sources: Array<Record<string, JsonValue>>;
    };
    assert.strictEqual(content.sources[0].resource, "demo:block/sheet");
    assert.strictEqual(content.sources[0].sprite, "demo:block/custom");
    assert.strictEqual(content.sources[1].resource, "demo:block/sheet");
    assert.strictEqual(content.sources[1].sprite, "block/unknown");
    const regions = content.sources[1].regions as Array<Record<string, JsonValue>>;
    assert.strictEqual(regions[0].sprite, "demo:block/region");
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id),
      ["demo:block/sheet"]
    );
  });

  it("canonicalizes legacy unicode font files and placeholder templates", () => {
    const result = compileSource([
      "namespace demo",
      "extern! custom font_file demo:font/glyph_sizes.bin",
      "font legacy {",
      "  providers [{",
      "    type: \"minecraft:legacy_unicode\",",
      "    sizes: \"font/glyph_sizes.bin\",",
      "    template: \"font/unicode_page_%s.png\"",
      "  }]",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "assets/demo/font/legacy.json").content, {
      providers: [{
        type: "minecraft:legacy_unicode",
        sizes: "demo:font/glyph_sizes.bin",
        template: "demo:font/unicode_page_%s.png"
      }]
    });
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id),
      ["demo:font/glyph_sizes.bin"]
    );
  });

  it("uses an external parent model's namespace for relative parent and texture references", () => {
    const externalModels = new Map<string, Record<string, JsonValue>>([
      ["foreign:block/child", {
        parent: "block/root",
        textures: { all: "#base" },
        elements: [{
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: { texture: "#all" },
            south: { texture: "block/direct" }
          }
        }]
      }],
      ["foreign:block/root", {
        textures: { base: "block/texture" }
      }]
    ]);
    const contentRequests: string[] = [];
    const result = compileSource([
      "namespace demo",
      "extern! custom model foreign:**",
      "extern! custom texture foreign:**",
      "model block local {",
      "  parent foreign:block/child",
      "}"
    ], {
      externResourceContent: (_source, kind, id) => {
        assert.strictEqual(kind, "model");
        contentRequests.push(id);
        return externalModels.get(id);
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(contentRequests.sort(), ["foreign:block/child", "foreign:block/root"]);
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id).sort(),
      ["foreign:block/child", "foreign:block/direct", "foreign:block/root", "foreign:block/texture"]
    );
  });

  it("resolves external parent texture variables in the concrete child context", () => {
    const result = compileSource([
      "namespace demo",
      "extern! custom model foreign:block/slots",
      "extern! custom texture demo:block/actual",
      "model block local {",
      "  parent foreign:block/slots",
      "  textures { provided: block/actual }",
      "}"
    ], {
      externResourceContent: (_source, _kind, id) => id === "foreign:block/slots"
        ? {
          elements: [{
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#provided" } }
          }]
        }
        : undefined
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id).sort(),
      ["demo:block/actual", "foreign:block/slots"]
    );
  });

  it("honors declared external texture variables used by external parent geometry", () => {
    const result = compileSource([
      "extern! custom model foreign:block/slots",
      "model block local {",
      "  parent foreign:block/slots",
      "  extern var #provided",
      "}"
    ], {
      externResourceContent: (_source, _kind, id) => id === "foreign:block/slots"
        ? {
          elements: [{
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: "#provided" } }
          }]
        }
        : undefined
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      result.units.filter(unit => unit.external).map(unit => unit.external!.id),
      ["foreign:block/slots"]
    );
  });

  it("centralizes direct and folder-specific consumer contracts", () => {
    assert.deepStrictEqual(Object.keys(resourceReferenceConsumers).sort(), [
      "blockstate",
      "equipmentTexture",
      "font",
      "fontFile",
      "fontLegacyUnicodeTemplate",
      "item",
      "itemSpecialChestTexture",
      "itemSpecialCopperGolemTexture",
      "itemSpecialHeadTexture",
      "itemSpecialShulkerTexture",
      "model",
      "modelTexture",
      "particleTexture",
      "postEffectTexture",
      "shaderFragment",
      "shaderVertex",
      "sound",
      "texture",
      "textureDirectory",
      "waypointSpriteTexture"
    ]);
    assert.deepStrictEqual(
      canonicalizeResourceReference("particleTexture", "smoke", "demo"),
      {
        kind: "resource",
        targetKind: "texture",
        id: "demo:particle/smoke",
        lookupId: "demo:particle/smoke"
      }
    );
    assert.deepStrictEqual(
      canonicalizeResourceReference("equipmentTexture", "leather", "demo", { equipmentLayer: "humanoid" }),
      {
        kind: "resource",
        targetKind: "texture",
        id: "demo:leather",
        lookupId: "demo:entity/equipment/humanoid/leather"
      }
    );
    assert.deepStrictEqual(
      canonicalizeResourceReference("waypointSpriteTexture", "default_0", "demo"),
      {
        kind: "resource",
        targetKind: "texture",
        id: "demo:default_0",
        lookupId: "demo:gui/sprites/hud/locator_bar_dot/default_0"
      }
    );
    assert.deepStrictEqual(
      canonicalizeResourceReference("itemSpecialCopperGolemTexture", "textures/entity/golem.png", "demo"),
      {
        kind: "resource",
        targetKind: "texture",
        id: "demo:textures/entity/golem.png",
        lookupId: "demo:entity/golem"
      }
    );
    assert.deepStrictEqual(
      canonicalizeResourceReference("modelTexture", "#side/path", "demo"),
      { kind: "textureVariable", targetKind: "texture", value: "#side/path" }
    );
  });
});
