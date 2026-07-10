import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { RsglCompiler } from "../../src/compiler/compiler";
import { childEvaluationContext, type EvaluationContext } from "../../src/compiler/evaluate";
import { parseRsgl } from "../../src/parser";
import { externResourceKindDescription } from "../../src/resourceKinds";
import {
  compileSource,
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  generatedResourceUnits,
  unitByPath,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL use semantics, extern declarations, and convention templates", () => {
  it("keeps unused extern declarations out of compiler units", () => {
    const result = compileSource([
      "extern custom model minecraft:block/stone",
      "extern vanilla blockstate minecraft:stone",
      "extern custom item minecraft:stone",
      "extern vanilla texture minecraft:block/stone"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units, []);
  });

  it("diagnoses invalid extern patterns before compilation", () => {
    const result = compileSource(["extern custom model minecraft:block/bad*path"]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.invalidExternPattern"));
    assert.deepStrictEqual(result.units, []);
  });

  it("reports an unsupported extern kind once across semantic and compile validation", () => {
    const result = compileSource(["extern custom atlas minecraft:blocks"]);
    const diagnostics = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.invalidExternKind");

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(
      diagnostics[0].message,
      `Extern resource kind must be ${externResourceKindDescription}.`
    );
    assert.deepStrictEqual(result.units, []);
  });

  it("does not require extern declarations for generated resources", () => {
    const result = compileSource([
      "model block stone {}",
      "blockstate stone {",
      "  variants { {} -> { model: minecraft:block/stone } }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.strictEqual(result.units.length, 2);
    assert.ok(result.units.every(unit => unit.external === undefined));
  });

  it("lowers model impl clauses to parent and texture slots", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block ruby impl minecraft:block/cube_all(all: minecraft:block/ruby) {",
      "}",
      "model item diamond impl generated(layer0: minecraft:item/diamond) {",
      "}",
      "item diamond {",
      "  model minecraft:item/diamond",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/ruby.json").content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/ruby" }
    });
    assert.deepStrictEqual(unitByPath(result, "models/item/diamond.json").content, {
      parent: "minecraft:item/generated",
      textures: { layer0: "minecraft:item/diamond" }
    });
    assert.deepStrictEqual(unitByPath(result, "items/diamond.json").content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("maps model impl parent and texture slots in the source map", () => {
    const source = [
      "model block ruby impl minecraft:block/cube_all(all: minecraft:block/ruby) {",
      "}"
    ];
    const result = compileSourceWithUncheckedExterns(source);

    expectNoDiagnostics(result);
    const text = source.join("\n");
    const mappings = unitByPath(result, "models/block/ruby.json").sourceMap.mappings;
    const parentMapping = mappings.find(mapping => mapping.generatedPath === "/parent");
    assert.ok(parentMapping, "Expected a /parent mapping");
    assert.strictEqual(text.slice(parentMapping.sourceRange.start, parentMapping.sourceRange.end), "minecraft:block/cube_all");
    const textureMapping = mappings.find(mapping => mapping.generatedPath === "/textures/all");
    assert.ok(textureMapping, "Expected a /textures/all mapping");
    assert.strictEqual(text.slice(textureMapping.sourceRange.start, textureMapping.sourceRange.end), "minecraft:block/ruby");
  });

  it("prefers body texture mappings over impl slots and drops discarded body parent mappings", () => {
    const source = [
      "model block ruby impl minecraft:block/cube_all(all: minecraft:block/ruby) {",
      "  parent minecraft:block/cube",
      "  textures {",
      "    all minecraft:block/ruby_override",
      "  }",
      "}"
    ];
    const result = compileSourceWithUncheckedExterns(source);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.duplicateModelParent"));
    const unit = unitByPath(result, "models/block/ruby.json");
    assert.deepStrictEqual(unit.content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/ruby_override" }
    });
    const text = source.join("\n");
    const parentMappings = unit.sourceMap.mappings.filter(mapping => mapping.generatedPath === "/parent");
    assert.strictEqual(parentMappings.length, 1);
    assert.strictEqual(text.slice(parentMappings[0].sourceRange.start, parentMappings[0].sourceRange.end), "minecraft:block/cube_all");
    const textureMappings = unit.sourceMap.mappings.filter(mapping => mapping.generatedPath === "/textures/all");
    assert.strictEqual(textureMappings.length, 1);
    assert.ok(text.slice(textureMappings[0].sourceRange.start, textureMappings[0].sourceRange.end).includes("ruby_override"));
  });

  it("does not map impl texture slots that a body textures expression owns", () => {
    const source = [
      "let bodyTextures = { all: minecraft:block/body_tex }",
      "model block ruby impl minecraft:block/cube_all(minecraft:block/impl_tex) {",
      "  textures bodyTextures",
      "}"
    ];
    const result = compileSourceWithUncheckedExterns(source);

    expectNoDiagnostics(result);
    const unit = unitByPath(result, "models/block/ruby.json");
    assert.deepStrictEqual(unit.content, {
      parent: "minecraft:block/cube_all",
      textures: { all: "minecraft:block/body_tex" }
    });
    // The body's `textures <expr>` only maps "/textures", yet its slots win the
    // merge — the impl argument must not claim "/textures/all".
    assert.deepStrictEqual(unit.sourceMap.mappings.filter(mapping => mapping.generatedPath === "/textures/all"), []);
    assert.ok(unit.sourceMap.mappings.some(mapping => mapping.generatedPath === "/textures"));
  });

  it("expands item and model convention templates from stdlib imports", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { cubeAllModel, generatedItem, simpleItem } from \"rsgl:conventions/items.rsgl\"",
      "use cubeAllModel(id: ruby, all: minecraft:block/ruby)",
      "use generatedItem(id: diamond, layer0: minecraft:item/diamond)",
      "use simpleItem(id: ruby_block, model: minecraft:block/ruby_block)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(generatedResourceUnits(result).map(unit => unit.outputPath).sort(), [
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/items/ruby_block.json",
      "assets/minecraft/models/block/ruby.json",
      "assets/minecraft/models/item/diamond.json"
    ]);
  });

  // These `use` targets are intentionally undefined: the helpers were removed
  // when hardcoded use builtins migrated to stdlib convention templates. The
  // test pins the diagnostics users get when stale sources still reference them.
  it("diagnoses removed top-level hardcoded use helpers", () => {
    const result = compileSourceWithUncheckedExterns([
      "use externalModel(id: minecraft:block/stone)",
      "use cubeAll(id: ruby)",
      "use itemGenerated(id: diamond, texture: minecraft:item/diamond)",
      "use blockFamily(base: acacia, texture: minecraft:block/acacia_planks)",
      "use stairs(id: ruby_stairs)"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.undefinedSymbol"));
    assert.ok(codes.includes("rsgl.notCallable"));
    assert.ok(codes.includes("rsgl.unknownTemplate"));
    assert.deepStrictEqual(generatedResourceUnits(result), []);
  });

  it("separates full blockstate templates from blockstate fragments", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stairs } from \"rsgl:conventions/blockstate_fragments.rsgl\"",
      "import { stairsBlockstate } from \"rsgl:conventions/blockstates.rsgl\"",
      "use stairsBlockstate(id: ruby_stairs)",
      "blockstate custom_stairs {",
      "  use stairs(",
      "    base: minecraft:block/custom_stairs,",
      "    inner: minecraft:block/custom_stairs_inner,",
      "    outer: minecraft:block/custom_stairs_outer",
      "  )",
      "}"
    ]);

    expectNoDiagnostics(result);
    const generated = unitByPath(result, "blockstates/ruby_stairs.json");
    const generatedVariants = (generated.content as { variants: Record<string, unknown> }).variants;
    assert.strictEqual(Object.keys(generatedVariants).length, 40);
    assert.deepStrictEqual(generatedVariants["facing=east,half=bottom,shape=straight"], {
      model: "minecraft:block/ruby_stairs"
    });

    const custom = unitByPath(result, "blockstates/custom_stairs.json");
    const customVariants = (custom.content as { variants: Record<string, unknown> }).variants;
    assert.deepStrictEqual(customVariants["facing=east,half=bottom,shape=inner_left"], {
      model: "minecraft:block/custom_stairs_inner",
      y: 270,
      uvlock: true
    });
  });
});

describe("RSGL lambda arguments to imported templates", () => {
  it("checks lambda bodies passed to imported templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: age, values: [0], model: value => `minecraft:block/${vlaue}`)",
      "}"
    ]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.undefinedSymbol"));
  });

  it("reports lambda typos once for import-all modules", () => {
    const result = compileSourceWithUncheckedExterns([
      "import \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: \"age\", values: [0], model: value => `minecraft:block/${vlaue}`)",
      "}"
    ]);

    const undefinedSymbols = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.undefinedSymbol");
    assert.strictEqual(undefinedSymbols.length, 1);
  });

  it("resolves lambda captures of loop variables, template parameters, and local lets", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "template lampFamily(base: String) {",
      "  blockstate `${base}_lamp` {",
      "    use stateSequence(key: lit, values: [0], model: value => `minecraft:block/${base}_lamp_${value}`)",
      "  }",
      "}",
      "use lampFamily(base: \"copper\")",
      "for tint in [\"red\", \"green\"] {",
      "  blockstate `${tint}_case` {",
      "    let prefix = `minecraft:block/${tint}`",
      "    use stateSequence(key: lit, values: [0], model: value => `${prefix}_case_${value}`)",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "blockstates/copper_lamp.json").content, {
      variants: { "lit=0": { model: "minecraft:block/copper_lamp_0" } }
    });
    assert.deepStrictEqual(unitByPath(result, "blockstates/red_case.json").content, {
      variants: { "lit=0": { model: "minecraft:block/red_case_0" } }
    });
  });

  it("expands stateSequence with range values without type diagnostics", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: age, values: 0..2, model: value => `minecraft:block/cactus_${value}`)",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "blockstates/cactus.json").content, {
      variants: {
        "age=0": { model: "minecraft:block/cactus_0" },
        "age=1": { model: "minecraft:block/cactus_1" },
        "age=2": { model: "minecraft:block/cactus_2" }
      }
    });
  });

  it("rejects stateSequence values that are neither a list nor a range", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: age, values: true, model: value => `minecraft:block/cactus_${value}`)",
      "}"
    ]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.typeMismatch"));
  });

  it("accepts object-returning rangeFrames model lambdas", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { rangeFrames } from \"rsgl:conventions/item_definitions.rsgl\"",
      "use rangeFrames(",
      "  id: compass,",
      "  property: minecraft:custom_model_data,",
      "  values: [0],",
      "  model: frame => { type: \"minecraft:model\", model: `minecraft:item/compass_${frame}` },",
      "  fallback: minecraft:item/compass",
      ")"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "items/compass.json").content, {
      model: {
        type: "minecraft:range_dispatch",
        property: "minecraft:custom_model_data",
        entries: [
          { threshold: 0, model: { type: "minecraft:model", model: "minecraft:item/compass_0" } }
        ],
        fallback: {
          type: "minecraft:model",
          model: "minecraft:item/compass"
        }
      }
    });
  });

  it("reports lambda arity mismatches once, attributed to the expanded template call", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { rangeFrames } from \"rsgl:conventions/item_definitions.rsgl\"",
      "use rangeFrames(",
      "  id: compass,",
      "  property: minecraft:custom_model_data,",
      "  values: 0..2,",
      "  model: () => minecraft:item/compass,",
      "  fallback: minecraft:item/compass",
      ")"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.typeMismatch"), "expected the semantic layer to reject the () -> ... lambda at the argument");
    const arityMismatches = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaArityMismatch");
    assert.strictEqual(arityMismatches.length, 1, "the evaluator must report the arity mismatch exactly once, not per frame");
    assert.ok(
      arityMismatches[0].fileName?.includes("item_definitions"),
      "the evaluator report must be attributed to the stdlib file containing the call"
    );
  });

  it("reports direct lambda arity mismatches once at the call site", () => {
    const source = [
      "let m = (a) => a",
      "let x = m(1, 2)"
    ];
    const result = compileSourceWithUncheckedExterns(source);

    const arityMismatches = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaArityMismatch");
    assert.strictEqual(arityMismatches.length, 1, "semantic and evaluator reports for one call must collapse into one diagnostic");
    const text = source.join("\n");
    assert.strictEqual(text.slice(arityMismatches[0].range.start, arityMismatches[0].range.end), "m(1, 2)");
  });

  it("reports arity mismatches for imported lambda values at the call site", () => {
    const libFile = path.resolve("lib.rsgl");
    const mainFile = path.resolve("main.rsgl");
    const result = compileRsglProgram([
      { fileName: libFile, module: parseRsgl("let double = (a) => a") },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { double } from \"./lib.rsgl\"",
          "let x = double(1, 2)"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const arityMismatches = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaArityMismatch");
    assert.strictEqual(arityMismatches.length, 1);
    assert.strictEqual(arityMismatches[0].fileName, mainFile, "the report must land in the file containing the bad call");
  });

  it("checks lambda arguments passed to imported lambda values", () => {
    const libFile = path.resolve("lib.rsgl");
    const mainFile = path.resolve("main.rsgl");
    const result = compileRsglProgram([
      { fileName: libFile, module: parseRsgl("let mapName = (fn) => fn(\"stone\")") },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { mapName } from \"./lib.rsgl\"",
          "let broken = mapName(v => `minecraft:block/${vlaue}`)"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol" && diagnostic.fileName === mainFile
    ));
  });

  it("checks imported template arguments inside overlay blocks", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "overlay \"candy\" {",
      "  blockstate cactus {",
      "    use stateSequence(key: \"age\", values: [0], model: value => `minecraft:block/${vlaue}`)",
      "  }",
      "}"
    ]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.undefinedSymbol"));
  });

  it("rejects lambda captures of local lets declared after the call", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: \"age\", values: [0], model: v => `${prefix}_${v}`)",
      "  let prefix = \"minecraft:block/p\"",
      "}"
    ]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.undefinedSymbol"));
  });

  it("skips import signature validation for shadowed template parameters", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "template wrap(stateSequence: (Json) -> ModelId) {",
      "  model block wrapped { parent stateSequence(0) }",
      "}",
      "use wrap(stateSequence: v => `minecraft:block/s_${v}`)"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/wrapped.json").content, {
      parent: "minecraft:block/s_0"
    });
  });

  it("rejects object-returning stateSequence model lambdas", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: \"age\", values: [0], model: value => { model: `minecraft:block/c_${value}`, y: 90 })",
      "}"
    ]);

    assert.ok(result.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.typeMismatch"));
  });

  it("reports nested impure lambdas once", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { stateSequence } from \"rsgl:conventions/blockstate_tables.rsgl\"",
      "blockstate cactus {",
      "  use stateSequence(key: \"age\", values: [0], model: value => [inner => glob(\"./x.json\")][0](value))",
      "}"
    ]);

    const impureCalls = result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaImpureCall");
    assert.strictEqual(impureCalls.length, 1);
  });

  it("reports impure lambda calls once without executing the glob loader", () => {
    const result = compileSourceWithUncheckedExterns([
      "import { rangeFrames } from \"rsgl:conventions/item_definitions.rsgl\"",
      "use rangeFrames(",
      "  id: compass,",
      "  property: minecraft:custom_model_data,",
      "  values: [0],",
      "  model: frame => glob(\"./missing.json\"),",
      "  fallback: minecraft:item/compass",
      ")"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.lambdaImpureCall").length, 1);
  });

  it("reports impure lambdas once even when loops recreate them", () => {
    const result = compileSourceWithUncheckedExterns([
      "for i in 0..9 {",
      "  let load = value => glob(\"./missing.json\")",
      "  let x = load(i)",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.lambdaImpureCall").length, 1);
  });

  it("never executes impure lambda bodies at compile time", () => {
    const loaderCalls: string[] = [];
    const compiler = new RsglCompiler(parseRsgl([
      "let load = value => glob(\"./missing.json\")",
      "let result = load(1)"
    ].join("\n")), {
      fileName: "main.rsgl",
      namespace: "minecraft",
      globLoader: pattern => {
        loaderCalls.push(pattern);
        return [];
      }
    });
    compiler.compile();

    assert.deepStrictEqual(loaderCalls, [], "the purity gate must refuse to execute the lambda body");
  });

  it("inherits onError in derived evaluation contexts", () => {
    const onError = () => { };
    const context: EvaluationContext = { namespace: "minecraft", variables: new Map(), onError };
    assert.strictEqual(childEvaluationContext(context, { x: 1 }).onError, onError);
  });
});
