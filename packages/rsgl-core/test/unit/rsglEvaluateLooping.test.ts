import * as assert from "node:assert";
import * as path from "node:path";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits
} from "./helpers/compile";

describe("RSGL expression evaluation and loops", () => {
  it("evaluates compile-time string helper functions", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block string_helpers {",
      "  merge {",
      "    starts: startsWith(\"oak_planks\", \"oak\")",
      "    ends: endsWith(\"oak_planks\", \"planks\")",
      "    replaced: replace(\"oak_planks\", \"oak\", \"birch\")",
      "    left: padStart(\"7\", 3, \"0\")",
      "    right: padEnd(\"x\", 3, \"_\")",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      starts: true,
      ends: true,
      replaced: "birch_planks",
      left: "007",
      right: "x__"
    });
  });

  it("expands finite for loops over lists", () => {
    const result = compileSourceWithUncheckedExterns([
      "for block in [minecraft:stone, minecraft:dirt] {",
      "  model block block impl minecraft:block/cube_all(all: `minecraft:block/${resource_path(block)}`) {",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
      "assets/minecraft/models/block/dirt.json",
      "assets/minecraft/models/block/stone.json"
    ]);
  });

  it("expands product loops and template string interpolation", () => {
    const result = compileSourceWithUncheckedExterns([
      "for state in product({ facing: [north, east], powered: [false, true] }) {",
      "  blockstate variants `lamp_${state.facing}_${state.powered}` {",
      "    case * => `minecraft:block/lamp_${state.facing}`",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/lamp_east_false.json",
      "assets/minecraft/blockstates/lamp_east_true.json",
      "assets/minecraft/blockstates/lamp_north_false.json",
      "assets/minecraft/blockstates/lamp_north_true.json"
    ]);
    const emptyVariantKey = "";
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("lamp_east_true.json"))?.content, {
      variants: {
        [emptyVariantKey]: {
          model: "minecraft:block/lamp_east"
        }
      }
    });
  });

  it("expands multidimensional for loops in stable cartesian order", () => {
    const result = compileSourceWithUncheckedExterns([
      "for base in [stone, dirt], variant in [smooth, cut] {",
      "  model block `${base}_${variant}` impl minecraft:block/cube_all(all: `minecraft:block/${base}_${variant}`) {",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath), [
      "assets/minecraft/models/block/stone_smooth.json",
      "assets/minecraft/models/block/stone_cut.json",
      "assets/minecraft/models/block/dirt_smooth.json",
      "assets/minecraft/models/block/dirt_cut.json"
    ]);
  });

  it("destructures compiler-created records in RSGL insertion order", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block ordered_record_binding {",
      "  for first, second in [{ \"10\": \"ten\", \"2\": \"two\" }] {",
      "    merge { first: first, second: second }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      first: "ten",
      second: "two"
    });
  });

  it("reports duplicate bindings in multidimensional for loops", () => {
    const result = compileSourceWithUncheckedExterns([
      "for item in [stone], item in [dirt] {",
      "  model block item impl minecraft:block/cube_all(all: minecraft:block/stone) {}",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.duplicateLoopBinding"));
  });

  it("evaluates match expressions, builtin constants, comparisons, and path helpers", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block paths {",
      "  parent minecraft:block/cube_all",
      "  merge {",
      "    metadata: {",
      "      model_path: model_path(minecraft:block/stone),",
      "      texture_path: texture_path(block/stone),",
      "      compare: 3 >= 2",
      "    }",
      "  }",
      "}",
      "blockstate variants orient {",
      "  for dir in HORIZONTAL {",
      "    case { facing: dir } => match dir {",
      "      north | south -> minecraft:block/line",
      "      _ -> minecraft:block/turn",
      "    } with {",
      "      y: yaw(dir)",
      "      uvlock: dir != north",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("models/block/paths.json"))?.content, {
      parent: "minecraft:block/cube_all",
      metadata: {
        ["model_path"]: "assets/minecraft/models/block/stone.json",
        ["texture_path"]: "assets/minecraft/textures/block/stone.png",
        compare: true
      }
    });
    assert.deepStrictEqual(generatedResourceUnits(result).find(unit => unit.outputPath.endsWith("blockstates/orient.json"))?.content, {
      variants: {
        ["facing=east"]: {
          model: "minecraft:block/turn",
          y: 90,
          uvlock: true
        },
        ["facing=north"]: {
          model: "minecraft:block/line"
        },
        ["facing=south"]: {
          model: "minecraft:block/line",
          y: 180,
          uvlock: true
        },
        ["facing=west"]: {
          model: "minecraft:block/turn",
          y: 270,
          uvlock: true
        }
      }
    });
  });

  it("expands for and if statements inside resource bodies", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block layered {",
      "  parent minecraft:block/cube_all",
      "  if true {",
      "    ambientocclusion false",
      "  } else {",
      "    ambientocclusion true",
      "  }",
      "  textures {",
      "    for layer in [{ key: \"layer0\", tex: minecraft:block/stone }, { key: \"layer1\", tex: minecraft:block/dirt }] {",
      "      merge { [layer.key]: layer.tex }",
      "    }",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      parent: "minecraft:block/cube_all",
      ambientocclusion: false,
      textures: {
        layer0: "minecraft:block/stone",
        layer1: "minecraft:block/dirt"
      }
    });
  });

  it("records source map entries for resource body merges and loops", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block mapped {",
      "  merge { \"base/key\": true }",
      "  textures {",
      "    for layer in [{ key: \"layer/zero\", tex: minecraft:block/stone }, { key: \"layer1\", tex: minecraft:block/dirt }] {",
      "      merge { [layer.key]: layer.tex }",
      "    }",
      "  }",
      "}"
    ], { fileName: path.resolve("pack", "main.rsgl") });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].sourceMap.mappings.map(mapping => mapping.generatedPath), [
      "",
      "/base~1key",
      "/textures",
      "/textures/layer~1zero",
      "/textures/layer1"
    ]);

    const loopMappings = generatedResourceUnits(result)[0].sourceMap.mappings.filter(mapping => mapping.reason === "loop");
    assert.deepStrictEqual(loopMappings.map(mapping => mapping.generatedPath), [
      "/textures/layer~1zero",
      "/textures/layer1"
    ]);
    assert.ok(loopMappings.every(mapping => mapping.expansionStack.some(frame => frame.label === "for")));
  });

  it("expands literal range loops without non-finite loop diagnostics", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block age_layers {",
      "  textures {",
      "    for age in 0..2 {",
      "      merge { [`layer${age}`]: `minecraft:block/age_${age}` }",
      "    }",
      "  }",
      "}"
    ]);

    assert.strictEqual(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.compileNonFiniteLoop"), false);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      textures: {
        layer0: "minecraft:block/age_0",
        layer1: "minecraft:block/age_1",
        layer2: "minecraft:block/age_2"
      }
    });
  });

  it("reports non-finite loops inside resource bodies", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block bad {",
      "  for item in 1 {",
      "    parent minecraft:block/cube_all",
      "  }",
      "}"
    ]);

    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.compileNonFiniteLoop"));
  });
});
