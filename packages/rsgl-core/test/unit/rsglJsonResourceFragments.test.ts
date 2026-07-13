import * as assert from "node:assert";
import { compileRsglModule, stableJsonStringify, type JsonValue } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { compileSourceWithUncheckedExterns, expectNoDiagnostics, expectOnlyLegacyTemplateWarnings } from "./helpers/compile";

describe("RSGL JSON resources and generic fragments", () => {
  it("emits arbitrary pack-relative JSON resources", () => {
    const result = compileSourceWithUncheckedExterns([
      "json \"assets/minecraft/custom/diamond_gem\" {",
      "  parent minecraft:item/generated",
      "  textures {",
      "    layer0 minecraft:item/diamond",
      "  }",
      "}",
      "json example:config/feature {",
      "  enabled true",
      "  weight 2",
      "}"
    ]);

    expectNoDiagnostics(result);
    const custom = result.units.find(unit => unit.outputPath === "assets/minecraft/custom/diamond_gem.json");
    assert.strictEqual(custom?.kind, "json");
    assert.deepStrictEqual(custom?.id, { namespace: "minecraft", path: "custom/diamond_gem.json" });
    assert.deepStrictEqual(custom?.content, {
      parent: "minecraft:item/generated",
      textures: {
        layer0: "minecraft:item/diamond"
      }
    });
    assert.ok(custom?.sourceMap.mappings.some(mapping => mapping.generatedPath === "/textures/layer0"));
    assert.strictEqual(
      stableJsonStringify(custom?.content as JsonValue, "json"),
      "{\n  \"parent\": \"minecraft:item/generated\",\n  \"textures\": {\n    \"layer0\": \"minecraft:item/diamond\"\n  }\n}\n"
    );

    const resourceIdTarget = result.units.find(unit => unit.outputPath === "assets/example/config/feature.json");
    assert.strictEqual(resourceIdTarget?.kind, "json");
    assert.deepStrictEqual(resourceIdTarget?.id, { namespace: "example", path: "config/feature" });
    assert.deepStrictEqual(resourceIdTarget?.content, { enabled: true, weight: 2 });
  });

  it("rejects unsafe arbitrary JSON targets", () => {
    const result = compileSourceWithUncheckedExterns([
      "json \"../outside\" {",
      "  value true",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.compileInvalidJsonTarget"));
    assert.deepStrictEqual(result.units, []);
  });

  it("lowers generic JSON resource fragments", () => {
    const checkedResources: string[] = [];
    const result = compileSourceWithUncheckedExterns([
      "extern custom texture_directory minecraft:**",
      "extern custom texture *:**",
      "extern custom font_file minecraft:**",
      "extern custom shader_vertex minecraft:**",
      "extern custom shader_fragment minecraft:**",
      "template atlasSource(source: String, prefix: String) {",
      "  use atlasDirectory(source: source, prefix: prefix)",
      "}",
      "atlas minecraft:blocks {",
      "  use atlasSource(\"block\", \"block/\")",
      "  use atlasDirectory(source: \"item\", prefix: \"item/\")",
      "}",
      "particles explosion {",
      "  use particlesSeq(\"minecraft:particle/explosion_{00..02}\")",
      "}",
      "mcmeta \"assets/minecraft/textures/block/high_light.png\" {",
      "  use mcmetaAnimation(frametime: 5, interpolate: true)",
      "}",
      "equipment iron {",
      "  use equipmentLayers(texture: minecraft:iron, layers: [\"humanoid\", \"humanoid_leggings\"])",
      "}",
      "font default {",
      "  providers [",
      "    { type: reference, id: minecraft:include/space },",
      "    { type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }",
      "  ]",
      "}",
      "font include/space {",
      "  providers [{ type: space, advances: { \" \": 4 } }]",
      "}",
      "waypoint_style default {",
      "  near_distance 128",
      "  far_distance 332",
      "  sprites [minecraft:default_0, minecraft:default_1]",
      "}",
      "post_effect blur {",
      "  targets {",
      "    swap: { width: 640, height: 480, persistent: true }",
      "  }",
      "  passes [",
      "    { vertex_shader: minecraft:core/screenquad, fragment_shader: minecraft:post/box_blur, inputs: [{ sampler_name: \"Mask\", location: minecraft:blur/mask, width: 16, height: 16, bilinear: true }], output: \"swap\", uniforms: { BlurDir: [{ name: \"BlurDir\", type: \"vec2\", value: [1, 0] }] } }",
      "  ]",
      "}"
    ], {
      externResourceExists: (_source, kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return true;
      }
    });

    expectOnlyLegacyTemplateWarnings(result);
    assert.deepStrictEqual(result.units.filter(unit => !unit.external).map(unit => unit.outputPath).sort(), [
      "assets/minecraft/atlases/blocks.json",
      "assets/minecraft/equipment/iron.json",
      "assets/minecraft/font/default.json",
      "assets/minecraft/font/include/space.json",
      "assets/minecraft/particles/explosion.json",
      "assets/minecraft/post_effect/blur.json",
      "assets/minecraft/textures/block/high_light.png.mcmeta",
      "assets/minecraft/waypoint_style/default.json"
    ]);
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "atlas")?.content, {
      sources: [
        { type: "minecraft:directory", source: "minecraft:block", prefix: "block/" },
        { type: "minecraft:directory", source: "minecraft:item", prefix: "item/" }
      ]
    });
    const atlasMappingPaths = result.units.find(unit => unit.kind === "atlas")?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(atlasMappingPaths.includes("/sources/0/source"));
    assert.ok(atlasMappingPaths.includes("/sources/0/prefix"));
    assert.ok(atlasMappingPaths.includes("/sources/1/source"));
    assert.ok(atlasMappingPaths.includes("/sources/1/prefix"));
    const particles = result.units.find(unit => unit.kind === "particles");
    assert.deepStrictEqual(particles?.content, {
      textures: [
        "minecraft:particle/explosion_00",
        "minecraft:particle/explosion_01",
        "minecraft:particle/explosion_02"
      ]
    });
    const particleMappingPaths = particles?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(particleMappingPaths.includes("/textures"));
    assert.ok(particleMappingPaths.includes("/textures/0"));
    assert.ok(particleMappingPaths.includes("/textures/1"));
    assert.ok(particleMappingPaths.includes("/textures/2"));
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "mcmeta")?.content, {
      animation: {
        frametime: 5,
        interpolate: true
      }
    });
    const mcmetaMappingPaths = result.units.find(unit => unit.kind === "mcmeta")?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(mcmetaMappingPaths.includes("/animation/frametime"));
    assert.ok(mcmetaMappingPaths.includes("/animation/interpolate"));
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "equipment")?.content, {
      layers: {
        humanoid: [{ texture: "minecraft:iron" }],
        ["humanoid_leggings"]: [{ texture: "minecraft:iron" }]
      }
    });
    const equipmentMappingPaths = result.units.find(unit => unit.kind === "equipment")?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(equipmentMappingPaths.includes("/layers/humanoid/0/texture"));
    assert.ok(equipmentMappingPaths.includes("/layers/humanoid_leggings/0/texture"));
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "assets/minecraft/font/default.json")?.content, {
      providers: [
        { type: "reference", id: "minecraft:include/space" },
        { type: "bitmap", file: "minecraft:font/ascii.png", ascent: 7, chars: ["abc"] }
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "waypoint_style")?.content, {
      ["near_distance"]: 128,
      ["far_distance"]: 332,
      sprites: ["minecraft:default_0", "minecraft:default_1"]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.kind === "post_effect")?.content, {
      targets: {
        swap: { width: 640, height: 480, persistent: true }
      },
      passes: [
        {
          ["vertex_shader"]: "minecraft:core/screenquad",
          ["fragment_shader"]: "minecraft:post/box_blur",
          inputs: [
            { ["sampler_name"]: "Mask", location: "minecraft:blur/mask", width: 16, height: 16, bilinear: true }
          ],
          output: "swap",
          uniforms: {
            ["BlurDir"]: [{ name: "BlurDir", type: "vec2", value: [1, 0] }]
          }
        }
      ]
    });
    assert.ok(checkedResources.includes("texture:minecraft:particle/explosion_00"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:entity/equipment/humanoid_leggings/iron"));
    assert.ok(checkedResources.includes("texture:minecraft:font/ascii.png"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/default_0"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/default_1"));
    assert.ok(checkedResources.includes("shaderVertex:minecraft:core/screenquad"));
    assert.ok(checkedResources.includes("shaderFragment:minecraft:post/box_blur"));
    assert.ok(checkedResources.includes("texture:minecraft:effect/blur/mask"));
    assert.strictEqual(checkedResources.includes("font:minecraft:include/space"), false);
  });

  it("reports particlesSeq generated texture diagnostics at sequence positions", () => {
    const source = [
      "extern custom texture minecraft:particle/*",
      "particles explosion {",
      "  use particlesSeq(\"minecraft:particle/explosion_{00..02}\")",
      "}"
    ].join("\n");
    const result = compileRsglModule(parseRsgl(source), {
      externResourceExists: (_source, kind, id) => !(kind === "texture" && id === "minecraft:particle/explosion_01")
    });

    const particles = result.units.find(unit => unit.kind === "particles");
    const textureRange = particles?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/textures/1")?.sourceRange;
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.message.includes("explosion_01")
      && diagnostic.range.start === textureRange?.start
      && diagnostic.range.end === textureRange?.end
    ));
  });

  it("expands sequences with explicit padding control", () => {
    const result = compileSourceWithUncheckedExterns([
      "particles big_smoke {",
      "  use particlesSeq(\"minecraft:particle/big_smoke_{0..11}\")",
      "}",
      "particles padded {",
      "  use particlesSeq(\"minecraft:particle/explosion_{0..2}\", pad: 2)",
      "}",
      "particles named_seq {",
      "  use particlesSeq(seq(i => `minecraft:particle/spark_${i}`, i: 0..2, pad: 2))",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("big_smoke.json"))?.content, {
      textures: [
        "minecraft:particle/big_smoke_0",
        "minecraft:particle/big_smoke_1",
        "minecraft:particle/big_smoke_2",
        "minecraft:particle/big_smoke_3",
        "minecraft:particle/big_smoke_4",
        "minecraft:particle/big_smoke_5",
        "minecraft:particle/big_smoke_6",
        "minecraft:particle/big_smoke_7",
        "minecraft:particle/big_smoke_8",
        "minecraft:particle/big_smoke_9",
        "minecraft:particle/big_smoke_10",
        "minecraft:particle/big_smoke_11"
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("padded.json"))?.content, {
      textures: [
        "minecraft:particle/explosion_00",
        "minecraft:particle/explosion_01",
        "minecraft:particle/explosion_02"
      ]
    });
    assert.deepStrictEqual(result.units.find(unit => unit.outputPath.endsWith("named_seq.json"))?.content, {
      textures: [
        "minecraft:particle/spark_00",
        "minecraft:particle/spark_01",
        "minecraft:particle/spark_02"
      ]
    });

    const invalid = compileSourceWithUncheckedExterns([
      "particles bad {",
      "  use particlesSeq(\"minecraft:particle/bad_{0..2}\", pad: -1)",
      "}"
    ]);
    assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidParticlesSeqPadding"));
  });

  it("reports generic JSON helper diagnostics at helper argument ranges", () => {
    const source = [
      "extern custom texture_directory minecraft:missing",
      "extern custom texture minecraft:entity/equipment/humanoid/missing, minecraft:block/bad_anim, minecraft:gui/sprites/widget/bad_helper",
      "atlas minecraft:blocks {",
      "  use atlasDirectory(source: \"missing\", prefix: \"block/\")",
      "}",
      "equipment iron {",
      "  use equipmentLayers(texture: minecraft:missing, layers: [\"humanoid\"])",
      "}",
      "mcmeta \"assets/minecraft/textures/block/bad_anim.png\" {",
      "  use mcmetaAnimation(frametime: 0, interpolate: \"yes\")",
      "}",
      "mcmeta \"assets/minecraft/textures/gui/sprites/widget/bad_helper.png\" {",
      "  use nineSliceGui(width: 10, height: 10, border: -1)",
      "}"
    ].join("\n");
    const result = compileRsglModule(parseRsgl(source), {
      externResourceExists: (_source, kind, id) => !(kind === "textureDirectory" && id === "minecraft:missing")
        && !(kind === "texture" && id === "minecraft:entity/equipment/humanoid/missing"),
      textureMetadata: id => id === "minecraft:block/bad_anim" ? { width: 16, height: 16 } : null
    });

    const atlas = result.units.find(unit => unit.kind === "atlas");
    const equipment = result.units.find(unit => unit.kind === "equipment");
    const badAnim = result.units.find(unit => unit.outputPath.endsWith("bad_anim.png.mcmeta"));
    const badHelper = result.units.find(unit => unit.outputPath.endsWith("bad_helper.png.mcmeta"));
    const atlasSourceRange = atlas?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/sources/0/source")?.sourceRange;
    const equipmentTextureRange = equipment?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/layers/humanoid/0/texture")?.sourceRange;
    const frametimeRange = badAnim?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/animation/frametime")?.sourceRange;
    const interpolateRange = badAnim?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/animation/interpolate")?.sourceRange;
    const borderRange = badHelper?.sourceMap.mappings.find(mapping => mapping.generatedPath === "/gui/scaling/border")?.sourceRange;

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureDirectoryNotFound"
      && diagnostic.range.start === atlasSourceRange?.start
      && diagnostic.range.end === atlasSourceRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.textureNotFound"
      && diagnostic.range.start === equipmentTextureRange?.start
      && diagnostic.range.end === equipmentTextureRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidMcmetaFrameTime"
      && diagnostic.range.start === frametimeRange?.start
      && diagnostic.range.end === frametimeRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidMcmetaInterpolate"
      && diagnostic.range.start === interpolateRange?.start
      && diagnostic.range.end === interpolateRange?.end
    ));
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidMcmetaGuiScaling"
      && diagnostic.message.includes("border")
      && diagnostic.range.start === borderRange?.start
      && diagnostic.range.end === borderRange?.end
    ));
  });

  it("reports invalid generic JSON resource fragment arguments", () => {
    const result = compileSourceWithUncheckedExterns([
      "particles explosion {",
      "  use particlesSeq({ bad: true })",
      "}",
      "equipment iron {",
      "  use equipmentLayers(texture: minecraft:iron, layers: 1)",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidParticlesSeqArgument"));
    assert.ok(codes.includes("rsgl.invalidEquipmentLayersArgument"));
  });
});
