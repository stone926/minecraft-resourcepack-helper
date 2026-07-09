import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile, compileRsglModule } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSource, expectDiagnosticCodes, expectNoDiagnostics } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL atlas, equipment, and mcmeta sugar", () => {
  it("lowers atlas source sugar statements", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "atlas minecraft:blocks {",
      "  directory source \"block\" prefix \"block/\"",
      "  directory source \"potions\" prefix \"potions/\"",
      "  filter namespace \"minecraft\" path \"block/.*_debug\"",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    expectNoDiagnostics(result);
    const atlas = result.units.find(unit => unit.kind === "atlas");
    assert.deepStrictEqual(atlas?.content, {
      sources: [
        { type: "minecraft:directory", source: "block", prefix: "block/" },
        { type: "minecraft:directory", source: "potions", prefix: "potions/" },
        {
          type: "minecraft:filter",
          pattern: {
            namespace: "minecraft",
            path: "block/.*_debug"
          }
        }
      ]
    });
    assert.deepStrictEqual(atlas?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/sources",
      "/sources",
      "/sources"
    ]);
    assert.ok(checkedResources.includes("textureDirectory:minecraft:block"));
    assert.ok(checkedResources.includes("textureDirectory:minecraft:potions"));
  });

  it("lowers atlas paletted permutations sugar statements", () => {
    const source = [
      "let trimMaterials = [\"quartz\", \"iron\"]",
      "table trimPalettes {",
      "  quartz: minecraft:trims/color_palettes/quartz",
      "  iron: minecraft:trims/color_palettes/iron",
      "}",
      "atlas minecraft:armor_trims {",
      "  directory source \"trims/items\" prefix \"trims/items/\"",
      "  paletted_permutations {",
      "    textures seq(material => `minecraft:trims/items/helmet_trim_${material}`, material in trimMaterials)",
      "    palette_key minecraft:trims/color_palettes/trim_palette",
      "    permutations trimPalettes",
      "  }",
      "}"
    ].join("\n");
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl(source), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    expectNoDiagnostics(result);
    const atlas = result.units.find(unit => unit.kind === "atlas");
    assert.deepStrictEqual(atlas?.content, {
      sources: [
        { type: "minecraft:directory", source: "trims/items", prefix: "trims/items/" },
        {
          type: "minecraft:paletted_permutations",
          textures: [
            "minecraft:trims/items/helmet_trim_quartz",
            "minecraft:trims/items/helmet_trim_iron"
          ],
          ["palette_key"]: "minecraft:trims/color_palettes/trim_palette",
          permutations: {
            quartz: "minecraft:trims/color_palettes/quartz",
            iron: "minecraft:trims/color_palettes/iron"
          }
        }
      ]
    });
    const mappingPaths = atlas?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(mappingPaths.includes("/sources"));
    assert.ok(mappingPaths.includes("/sources/1"));
    assert.ok(mappingPaths.includes("/sources/1/textures"));
    assert.ok(mappingPaths.includes("/sources/1/palette_key"));
    assert.ok(mappingPaths.includes("/sources/1/permutations"));
    assert.strictEqual(mappingPaths.includes("/sources/0/textures"), false);
    assert.ok(checkedResources.includes("textureDirectory:minecraft:trims/items"));
    assert.ok(checkedResources.includes("texture:minecraft:trims/items/helmet_trim_quartz"));
    assert.ok(checkedResources.includes("texture:minecraft:trims/items/helmet_trim_iron"));
    assert.ok(checkedResources.includes("texture:minecraft:trims/color_palettes/trim_palette"));
    assert.ok(checkedResources.includes("texture:minecraft:trims/color_palettes/quartz"));
    assert.ok(checkedResources.includes("texture:minecraft:trims/color_palettes/iron"));

    const missing = compileRsglModule(parseRsgl(source), {
      resourceExists: (kind, id) => !(kind === "texture" && id === "minecraft:trims/items/helmet_trim_quartz")
    });
    const textureRange = atlas?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/sources/1/textures")?.sourceRange;
    assert.ok(missing.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("helmet_trim_quartz")
      && diagnostic.range.start === textureRange?.start
      && diagnostic.range.end === textureRange?.end
    ));
  });

  it("reports invalid atlas source sugar statements", () => {
    const result = compileSource([
      "atlas minecraft:blocks {",
      "  directory prefix \"block/\"",
      "  filter namespace \"minecraft\"",
      "  paletted_permutations {",
      "    textures 1",
      "    palette_key minecraft:trims/color_palettes/trim_palette",
      "    permutations []",
      "  }",
      "}"
    ]);

    expectDiagnosticCodes(result, [
      "rsgl.invalidAtlasDirectorySource",
      "rsgl.invalidAtlasFilter",
      "rsgl.invalidAtlasPalettedPermutations"
    ]);
  });

  it("lowers equipment layer sugar statements", () => {
    const source = [
      "equipment minecraft:iron {",
      "  layers [horse_body, humanoid]",
      "  texture minecraft:iron",
      "}",
      "equipment minecraft:leather {",
      "  layer humanoid texture minecraft:leather dyeable color 0xA06500",
      "  layer humanoid texture minecraft:leather_overlay",
      "  layer humanoid_leggings texture minecraft:leather_leggings dyeable color 0xA06500",
      "  layer humanoid_leggings texture minecraft:leather_leggings_overlay",
      "}"
    ].join("\n");
    const checkedResources: string[] = [];
    const result = compileRsglModule(parseRsgl(source), {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    expectNoDiagnostics(result);
    const iron = result.units.find(unit => unit.outputPath.endsWith("iron.json"));
    const leather = result.units.find(unit => unit.outputPath.endsWith("leather.json"));
    assert.deepStrictEqual(iron?.content, {
      layers: {
        ["horse_body"]: [{ texture: "minecraft:iron" }],
        humanoid: [{ texture: "minecraft:iron" }]
      }
    });
    assert.deepStrictEqual(iron?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/layers"
    ]);
    assert.deepStrictEqual(leather?.content, {
      layers: {
        humanoid: [
          { texture: "minecraft:leather", dyeable: { ["color_when_undyed"]: 10511616 } },
          { texture: "minecraft:leather_overlay" }
        ],
        ["humanoid_leggings"]: [
          { texture: "minecraft:leather_leggings", dyeable: { ["color_when_undyed"]: 10511616 } },
          { texture: "minecraft:leather_leggings_overlay" }
        ]
      }
    });
    const leatherMappingPaths = leather?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(leatherMappingPaths.includes("/layers/humanoid/0/texture"));
    assert.ok(leatherMappingPaths.includes("/layers/humanoid/1/texture"));
    assert.ok(leatherMappingPaths.includes("/layers/humanoid_leggings/0/texture"));
    assert.ok(leatherMappingPaths.includes("/layers/humanoid_leggings/1/texture"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/horse_body/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/leather"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid_leggings/leather_leggings_overlay"));

    const missing = compileRsglModule(parseRsgl(source), {
      resourceExists: (kind, id) => !(kind === "texture" && id === "minecraft:entity/equipment/humanoid/leather_overlay")
    });
    const textureRange = leather?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/layers/humanoid/1/texture")?.sourceRange;
    assert.ok(missing.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("leather_overlay")
      && diagnostic.range.start === textureRange?.start
      && diagnostic.range.end === textureRange?.end
    ));
  });

  it("reports invalid equipment layer sugar statements", () => {
    const result = compileSource([
      "equipment minecraft:broken {",
      "  layer humanoid dyeable",
      "}",
      "equipment minecraft:compact_broken {",
      "  layers [humanoid]",
      "}"
    ]);

    expectDiagnosticCodes(result, [
      "rsgl.invalidEquipmentLayerTexture",
      "rsgl.invalidEquipmentLayersTexture"
    ]);
  });

  it("lowers and validates mcmeta GUI scaling sugar", () => {
    const result = compileSource([
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/button.png\" {",
      "  use nineSliceGui(width: 200, height: 20, border: 2, stretch_inner: true)",
      "}",
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/panel.png\" {",
      "  gui {",
      "    scaling {",
      "      type tile",
      "      width 16",
      "      height 16",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("button.png.mcmeta"))?.content, {
      gui: {
        scaling: {
          type: "nine_slice",
          width: 200,
          height: 20,
          border: 2,
          ["stretch_inner"]: true
        }
      }
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("panel.png.mcmeta"))?.content, {
      gui: {
        scaling: {
          type: "tile",
          width: 16,
          height: 16
        }
      }
    });
  });

  it("reports invalid mcmeta GUI scaling metadata", () => {
    const result = compileSource([
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/bad.png\" {",
      "  gui {",
      "    scaling {",
      "      type nine_slice",
      "      width 16",
      "      border -1",
      "      stretch_inner \"yes\"",
      "    }",
      "  }",
      "}",
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/bad_helper.png\" {",
      "  use nineSliceGui(width: \"wide\", height: 10, border: 1)",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidMcmetaGuiScaling"));
    assert.ok(codes.includes("rsgl.invalidJsonResourceFragmentArgument"));
  });

  it("validates mcmeta texture metadata and target support", () => {
    const result = compileSource([
      "target java format 74",
      "mcmeta \"assets/minecraft/textures/block/cutout.png\" {",
      "  texture {",
      "    blur \"yes\"",
      "    clamp true",
      "    alpha_cutoff_bias 0.1",
      "  }",
      "}",
      "mcmeta \"assets/minecraft/textures/block/bad_alpha.png\" {",
      "  texture { alpha_cutoff_bias \"high\" }",
      "}"
    ], {
      resourceExists: () => true
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidMcmetaTextureField"));
    assert.ok(codes.includes("rsgl.unsupportedMcmetaAlphaCutoffBias"));
    assert.ok(codes.includes("rsgl.invalidMcmetaAlphaCutoffBias"));

    const cutout = result.units.find(unit => unit.outputPath.endsWith("cutout.png.mcmeta"));
    const alphaRange = cutout?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/texture/alpha_cutoff_bias")?.sourceRange;
    const unsupported = result.diagnostics.find(diagnostic => diagnostic.code === "rsgl.unsupportedMcmetaAlphaCutoffBias");
    assert.deepStrictEqual(unsupported?.range, alphaRange);

    const supported = compileSource([
      "target java format [75, 0]",
      "mcmeta \"assets/minecraft/textures/block/cutout.png\" {",
      "  texture {",
      "    blur false",
      "    clamp true",
      "    alpha_cutoff_bias 0.1",
      "  }",
      "}"
    ], {
      resourceExists: () => true
    });

    expectNoDiagnostics(supported);
    assert.deepStrictEqual(supported.units[0].content, {
      texture: {
        blur: false,
        clamp: true,
        ["alpha_cutoff_bias"]: 0.1
      }
    });
  });

  it("expands mcmeta glob targets relative to the resource pack root", () => {
    const root = createTempDir();
    try {
      const rsglDir = path.join(root, "rsgl");
      const textureDir = path.join(root, "assets", "minecraft", "textures", "block");
      fs.mkdirSync(rsglDir, { recursive: true });
      fs.mkdirSync(textureDir, { recursive: true });
      fs.writeFileSync(path.join(root, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(textureDir, "glow_0.png"), "");
      fs.writeFileSync(path.join(textureDir, "glow_1.png"), "");
      fs.writeFileSync(path.join(textureDir, "other.png"), "");

      const mainFile = path.join(rsglDir, "main.rsgl");
      fs.writeFileSync(mainFile, [
        "mcmeta glob(\"assets/minecraft/textures/block/glow_*.png\") {",
        "  use mcmetaAnimation(frametime: 3)",
        "}"
      ].join("\n"));
      const checkedResources: string[] = [];
      const result = compileRsglFile(mainFile, {
        resourceExists: (kind, id) => {
          checkedResources.push(`${kind}:${id}`);
          return true;
        }
      });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/textures/block/glow_0.png.mcmeta",
        "assets/minecraft/textures/block/glow_1.png.mcmeta"
      ]);
      for (const unit of result.units) {
        assert.deepStrictEqual(unit.content, {
          animation: {
            frametime: 3
          }
        });
      }
      assert.ok(checkedResources.includes("texture:minecraft:block/glow_0"));
      assert.ok(checkedResources.includes("texture:minecraft:block/glow_1"));

      fs.writeFileSync(mainFile, [
        "mcmeta glob(\"assets/minecraft/textures/block/missing_*.png\") {",
        "  animation { frametime 1 }",
        "}"
      ].join("\n"));
      const empty = compileRsglFile(mainFile);

      assert.ok(empty.diagnostics.some(diagnostic => diagnostic.code === "rsgl.mcmetaGlobNoMatches"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
