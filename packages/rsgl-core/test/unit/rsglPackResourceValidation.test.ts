import * as assert from "node:assert/strict";
import { compileSource, compileSourceWithUncheckedExterns, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL pack, lang, sounds, and metadata resources", () => {
  it("emits pack, lang, sounds, and mcmeta resources", () => {
    const result = compileSourceWithUncheckedExterns([
      "pack {",
      "  description \"Generated pack\"",
      "  min_format [88, 0]",
      "  max_format [88, 0]",
      "}",
      "lang en_us {",
      "  \"block.minecraft.stone\" \"Stone\"",
      "}",
      "lang minecraft:en_us {",
      "  \"item.minecraft.stick\" \"Stick\"",
      "}",
      "sounds minecraft {",
      "  \"block.example.break\" { sounds: [\"block/example_break\"] }",
      "}",
      "mcmeta \"assets/minecraft/textures/block/glow.png\" {",
      "  animation { frametime 5 }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units
      .filter(unit => unit.external === undefined)
      .map(unit => unit.outputPath)
      .sort(), [
      "assets/minecraft/lang/en_us.json",
      "assets/minecraft/sounds.json",
      "assets/minecraft/textures/block/glow.png.mcmeta",
      "pack.mcmeta"
    ]);

    const pack = result.units.find(unit => unit.kind === "pack");
    assert.deepStrictEqual(pack?.content, {
      pack: {
        description: "Generated pack",
        ["min_format"]: [88, 0],
        ["max_format"]: [88, 0]
      }
    });
    assert.deepStrictEqual(pack?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/pack/description",
      "/pack/min_format",
      "/pack/max_format"
    ]);

    const expectedLang = {
      ["block.minecraft.stone"]: "Stone",
      ["item.minecraft.stick"]: "Stick"
    };
    const lang = result.units.find(unit => unit.kind === "lang");
    assert.deepStrictEqual(lang?.content, expectedLang);
    assert.deepStrictEqual(lang?.sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/block.minecraft.stone",
      "",
      "/item.minecraft.stick"
    ]);

    const expectedSounds = {
      ["block.example.break"]: {
        sounds: ["minecraft:block/example_break"]
      }
    };
    const sounds = result.units.find(unit => unit.kind === "sounds");
    assert.deepStrictEqual(sounds?.content, expectedSounds);

    const mcmeta = result.units.find(unit => unit.kind === "mcmeta");
    assert.deepStrictEqual(mcmeta?.content, {
      animation: {
        frametime: 5
      }
    });
  });

  it("fills pack metadata from RSGL target declarations", () => {
    const modern = compileSource([
      "target java mc \"1.21.11\"",
      "pack {",
      "  description \"Generated pack\"",
      "}"
    ]);
    const legacy = compileSource([
      "target java mc \"1.21.8\"",
      "pack {",
      "  description \"Legacy pack\"",
      "}"
    ]);
    const explicit = compileSource([
      "target java mc \"1.21.11\"",
      "pack {",
      "  description \"Explicit pack\"",
      "  pack_format 12",
      "}"
    ]);

    assert.deepStrictEqual(modern.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Generated pack",
        ["min_format"]: [75, 0],
        ["max_format"]: [75, 0]
      }
    });
    assert.deepStrictEqual(legacy.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Legacy pack",
        ["pack_format"]: 64
      }
    });
    assert.deepStrictEqual(explicit.units.find(unit => unit.kind === "pack")?.content, {
      pack: {
        description: "Explicit pack",
        ["pack_format"]: 12
      }
    });
  });

  it("validates lang and sounds resource structure", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom sound custom:entity/example/valid",
      "lang en_us {",
      "  \"valid.key\" \"Valid\"",
      "  merge { \"bad.key\": 1 }",
      "}",
      "lang deprecated {",
      "  merge { removed: [\"old.key\", 1], renamed: { \"old.key\": 2 } }",
      "}",
      "sounds custom {",
      "  \"valid.event\" { sounds: [\"entity/example/valid\"] }",
      "  \"bad.event\" {",
      "    replace: \"yes\"",
      "    subtitle: 1",
      "    sounds: [",
      "      \"entity/example/bad sound.ogg\",",
      "      { type: \"event\", name: \"missing.event\" },",
      "      { type: \"bad\", name: 1, volume: 0, pitch: -1, weight: 0, attenuation_distance: 0, preload: \"yes\", stream: 1 },",
      "      1",
      "    ]",
      "  }",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidLangValue"));
    assert.ok(codes.includes("rsgl.invalidLangDeprecated"));
    assert.ok(codes.includes("rsgl.invalidSoundsEventField"));
    assert.ok(codes.includes("rsgl.invalidSoundReference"));
    assert.ok(codes.includes("rsgl.soundEventNotFound"));
    assert.ok(codes.includes("rsgl.invalidSoundField"));
    assert.ok(codes.includes("rsgl.missingSoundName"));
    assert.ok(codes.includes("rsgl.invalidSoundEntry"));
    assert.ok(codes.includes("rsgl.soundNotFound"));
    assert.ok(checkedResources.includes("sound:custom:entity/example/valid"));
  });

  it("validates sound metadata through compiler hooks", () => {
    const result = compileSource([
      "extern custom sound custom:entity/example/unreadable, custom:entity/example/bad_shape, custom:entity/example/valid",
      "sounds custom {",
      "  \"entity.example\" {",
      "    sounds: [",
      "      \"entity/example/unreadable\",",
      "      \"entity/example/bad_shape\",",
      "      \"entity/example/valid\"",
      "    ]",
      "  }",
      "}"
    ], {
      resourceExists: () => true,
      soundMetadata: id => {
        if (id.endsWith("unreadable")) {
          return null;
        }
        if (id.endsWith("bad_shape")) {
          return { codec: "opus", channels: 0, sampleRate: 0, durationSeconds: -1 };
        }
        return { codec: "vorbis", channels: 2, sampleRate: 44100, durationSeconds: 1 };
      }
    });

    const invalidSoundMetadata = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.invalidSoundMetadata");
    assert.strictEqual(invalidSoundMetadata.length, 5);
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("could not be read")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("unsupported codec")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("channel count")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("sample rate")));
    assert.ok(invalidSoundMetadata.some(diagnostic => diagnostic.message.includes("duration")));
  });

  it("validates font provider resources", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom texture minecraft:font/missing.png",
      "extern custom font minecraft:missing_font",
      "extern custom font_file example:missing.ttf, example:missing.hex",
      "font invalid {",
      "  providers [",
      "    1,",
      "    { type: unknown },",
      "    { type: bitmap },",
      "    { type: bitmap, file: minecraft:font/missing.png, chars: [1], ascent: \"bad\", shift: [0, 999], filter: { uniform: \"yes\" } },",
      "    { type: reference, id: minecraft:missing_font },",
      "    { type: ttf, file: example:missing.ttf, skip: [1] },",
      "    { type: unihex, hex_file: example:missing.hex, size_overrides: [{ left: -1, right: 33, ranges: [1] }] },",
      "    { type: space, advances: { \" \": \"wide\" } }",
      "  ]",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidFontProvider"));
    assert.ok(codes.includes("rsgl.invalidFontProviderType"));
    assert.ok(codes.includes("rsgl.missingFontProviderField"));
    assert.ok(codes.includes("rsgl.invalidFontProviderField"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(codes.includes("rsgl.fontNotFound"));
    assert.ok(codes.includes("rsgl.fontFileNotFound"));
    assert.ok(checkedResources.includes("texture:minecraft:font/missing.png"));
    assert.ok(checkedResources.includes("font:minecraft:missing_font"));
    assert.ok(checkedResources.includes("fontFile:example:missing.ttf"));
    assert.ok(checkedResources.includes("fontFile:example:missing.hex"));
  });

  it("validates waypoint style resources", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom texture minecraft:gui/sprites/hud/locator_bar_dot/missing",
      "waypoint_style invalid {",
      "  near_distance 400",
      "  far_distance 100",
      "  sprites [minecraft:missing, 1, \"\"]",
      "}",
      "waypoint_style missing {",
      "  near_distance -1",
      "  far_distance \"bad\"",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidWaypointDistance"));
    assert.ok(codes.includes("rsgl.invalidWaypointDistanceRange"));
    assert.ok(codes.includes("rsgl.invalidWaypointSprite"));
    assert.ok(codes.includes("rsgl.missingWaypointSprites"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(checkedResources.includes("texture:minecraft:gui/sprites/hud/locator_bar_dot/missing"));
  });

  it("validates post effect resources", () => {
    const checkedResources: string[] = [];
    const result = compileSource([
      "extern custom shader_vertex minecraft:core/missing",
      "extern custom shader_fragment minecraft:post/missing",
      "extern custom texture minecraft:effect/missing",
      "post_effect invalid {",
      "  targets {",
      "    swap: { width: 0, height: \"bad\", persistent: \"yes\", clear_color: [1, 2, 3] }",
      "  }",
      "  passes [",
      "    1,",
      "    { vertex_shader: 1, fragment_shader: minecraft:post/missing, inputs: 1, uniforms: [] },",
      "    { vertex_shader: minecraft:core/missing, fragment_shader: minecraft:post/missing, output: \"swap\", inputs: [",
      "      1,",
      "      { sampler_name: 1, target: \"missing\", location: minecraft:missing, width: 0, height: \"bad\", use_depth_buffer: \"yes\", bilinear: \"no\" },",
      "      { target: \"swap\" }",
      "    ], uniforms: { Bad: [1, { name: 1, type: \"bad\", value: [\"bad\"] }] } },",
      "    { output: \"missing\", inputs: [{ target: \"missing\" }] }",
      "  ]",
      "}",
      "post_effect invalid_shapes {",
      "  merge { targets: [], passes: {} }",
      "}"
    ], {
      resourceExists: (kind, id) => {
        checkedResources.push(`${kind}:${id}`);
        return false;
      }
    });

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidPostEffectTargetField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPasses"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPass"));
    assert.ok(codes.includes("rsgl.invalidPostEffectPassField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInputs"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInput"));
    assert.ok(codes.includes("rsgl.invalidPostEffectInputField"));
    assert.ok(codes.includes("rsgl.invalidPostEffectUniform"));
    assert.ok(codes.includes("rsgl.invalidPostEffectUniformField"));
    assert.ok(codes.includes("rsgl.postEffectTargetNotFound"));
    assert.ok(codes.includes("rsgl.invalidPostEffectTargetFlow"));
    assert.ok(codes.includes("rsgl.vertexShaderNotFound"));
    assert.ok(codes.includes("rsgl.fragmentShaderNotFound"));
    assert.ok(codes.includes("rsgl.textureNotFound"));
    assert.ok(checkedResources.includes("shaderVertex:minecraft:core/missing"));
    assert.ok(checkedResources.includes("shaderFragment:minecraft:post/missing"));
    assert.ok(checkedResources.includes("texture:minecraft:effect/missing"));
  });

  it("validates pack metadata formats and filters", () => {
    const result = compileSource([
      "target java format [75, 0]",
      "pack {",
      "  pack {",
      "    description: \"Invalid\"",
      "    min_format: [66, 0]",
      "    max_format: [70, 0]",
      "    pack_format: 88",
      "    supported_formats: [1, 63]",
      "  }",
      "  filter {",
      "    block: [{ namespace: \"[\", path: \"*\" }]",
      "  }",
      "  overlays {",
      "    entries: [",
      "      { directory: \"legacy\", formats: [2, 1] },",
      "      { directory: \"old\", formats: [1, 64] }",
      "    ]",
      "  }",
      "}"
    ]);
    const modernPackFormat = compileSource([
      "pack {",
      "  description \"Invalid\"",
      "  pack_format 88",
      "}"
    ]);

    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unsupportedPackFormatFields"));
    assert.ok(codes.includes("rsgl.packOutsideTargetFormat"));
    assert.ok(codes.includes("rsgl.invalidPackFilterPattern"));
    assert.ok(codes.includes("rsgl.invalidOverlayFormatRange"));
    assert.ok(codes.includes("rsgl.overlayOutsideTargetFormat"));
    assert.ok(modernPackFormat.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.invalidPackFormatField"));
  });

  it("lowers pack metadata sugar to root pack.mcmeta sections", () => {
    const result = compileSource([
      "pack {",
      "  description \"Generated pack\"",
      "  formats min [88, 0] max [9999, 0]",
      "  overlay \"format_75\" {",
      "    formats min [75, 0] max [87, 9999]",
      "  }",
      "  filter {",
      "    block namespace \"minecraft\" path \"textures/block/stone.*\"",
      "  }",
      "}"
    ]);
    const pack = result.units.find(unit => unit.kind === "pack");

    expectNoDiagnostics(result);
    assert.deepStrictEqual(pack?.content, {
      pack: {
        description: "Generated pack",
        ["min_format"]: [88, 0],
        ["max_format"]: [9999, 0]
      },
      overlays: {
        entries: [{
          directory: "format_75",
          ["min_format"]: [75, 0],
          ["max_format"]: [87, 9999]
        }]
      },
      filter: {
        block: [{
          namespace: "minecraft",
          path: "textures/block/stone.*"
        }]
      }
    });
    const paths = pack?.sourceMap.mappings.map(mapping => mapping.generatedPath) ?? [];
    assert.ok(paths.includes("/pack/description"));
    assert.ok(paths.includes("/pack/min_format"));
    assert.ok(paths.includes("/pack/max_format"));
    assert.ok(paths.includes("/overlays"));
    assert.ok(paths.includes("/filter"));
    assert.ok(paths.includes("/filter/block"));
  });
});
