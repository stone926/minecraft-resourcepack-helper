import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram, type RsglSemanticModel } from "../../src/semantic";
import { resolvedTemplateOutputMetadata } from "../../src/templateOutput";
import {
  compileSourceWithUncheckedExterns,
  generatedResourceUnits,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL template output dialects", () => {
  it("freezes public and legacy output metadata on template signatures", () => {
    const model = bindRsglModule(parseRsgl([
      "template resources() { model block stone {} }",
      "template modelBody() -> model { parent minecraft:block/cube_all }",
      "template variantEntries() -> variants { [lit=true] -> { model: minecraft:block/lamp } }",
      "template multipartEntries() -> multipart { apply { model: minecraft:block/post } }",
      "template legacyRoot() { variants { {} -> { model: minecraft:block/stone } } }",
      "template ambiguous() { custom true }"
    ].join("\n")));

    assert.deepStrictEqual(templateMetadata(model, "resources"), {
      outputSource: "noArrowResources",
      outputDialect: "resources"
    });
    assert.deepStrictEqual(templateMetadata(model, "modelBody"), {
      outputSource: "explicitArrow",
      outputDialect: "model"
    });
    assert.deepStrictEqual(templateMetadata(model, "variantEntries"), {
      outputSource: "explicitArrow",
      outputDialect: "variants"
    });
    assert.deepStrictEqual(templateMetadata(model, "multipartEntries"), {
      outputSource: "explicitArrow",
      outputDialect: "multipart"
    });
    assert.deepStrictEqual(templateMetadata(model, "legacyRoot"), {
      outputSource: "legacyInferredBody",
      legacyOutputDialect: {
        kind: "blockstateRoot",
        mode: "variants",
        allowRootMerge: true,
        allowBase: false
      }
    });
    assert.deepStrictEqual(templateMetadata(model, "ambiguous"), {
      outputSource: "legacyContextualAdapter",
      bodyNodeKind: "ResourceBody"
    });
  });

  it("keeps node-aware mcmeta and nested pack evidence exact", () => {
    const model = bindRsglModule(parseRsgl([
      "template textureMetadata() { texture { blur: true } }",
      "template packFilter() {",
      "  filter {",
      "    block namespace \"minecraft\" path \"textures/block/stone.*\"",
      "  }",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(templateMetadata(model, "textureMetadata"), {
      outputSource: "legacyInferredBody",
      legacyOutputDialect: { kind: "resourceBody", resourceKind: "mcmeta" }
    });
    assert.deepStrictEqual(templateMetadata(model, "packFilter"), {
      outputSource: "legacyInferredBody",
      legacyOutputDialect: { kind: "resourceBody", resourceKind: "pack" }
    });
  });

  it("joins compatible blockstate capabilities and rejects conflicting definitions", () => {
    const model = bindRsglModule(parseRsgl([
      "template entries() -> variants { [lit=true] -> { model: minecraft:block/lamp } }",
      "template parts() -> multipart { apply { model: minecraft:block/post } }",
      "template rooted() { variants { [lit=false] -> { model: minecraft:block/lamp } } }",
      "template joinedByUse() { use entries()\nuse rooted() }",
      "template joinedByCustom() { custom true\nuse entries() }",
      "template joinedByMerge() { merge deep { custom: true }\nuse entries() }",
      "template joinedInControl() { if true { merge deep { custom: true } }\nuse entries() }",
      "template conflicting() { use entries()\nuse parts() }"
    ].join("\n")));

    const variantsRoot = {
      outputSource: "legacyInferredBody",
      legacyOutputDialect: {
        kind: "blockstateRoot",
        mode: "variants",
        allowRootMerge: true,
        allowBase: false
      }
    };
    assert.deepStrictEqual(templateMetadata(model, "joinedByUse"), variantsRoot);
    assert.deepStrictEqual(templateMetadata(model, "joinedByCustom"), variantsRoot);
    assert.deepStrictEqual(templateMetadata(model, "joinedByMerge"), variantsRoot);
    assert.deepStrictEqual(templateMetadata(model, "joinedInControl"), variantsRoot);
    assert.ok(model.diagnostics.some(item =>
      item.code === "rsgl.conflictingResolvedTemplateOutputDialects"
      && item.message.includes("conflicting")
    ));
    const conflict = model.scope.symbols.get("conflicting")?.signature?.templateOutputConflict;
    assert.ok(conflict);
    assert.ok(Object.isFrozen(conflict));
    assert.ok(Object.isFrozen(conflict.evidence));
  });

  it("propagates conflict carriers independently of recursive declaration order", () => {
    const bindOrder = (first: "a" | "b") => {
      const definitions = {
        a: "template a() { use modelPart()\nuse b() }",
        b: "template b() { use statePart()\nuse a() }"
      };
      const second = first === "a" ? "b" : "a";
      return bindRsglModule(parseRsgl([
        "template modelPart() -> model { texture layer0 minecraft:block/stone }",
        "template statePart() -> variants { [lit=true] -> { model: minecraft:block/lamp } }",
        definitions[first],
        definitions[second]
      ].join("\n")));
    };

    for (const model of [bindOrder("a"), bindOrder("b")]) {
      assert.ok(model.scope.symbols.get("a")?.signature?.templateOutputConflict);
      assert.ok(model.scope.symbols.get("b")?.signature?.templateOutputConflict);
    }
  });

  it("distinguishes contextual bodies from invalid mixed output definitions", () => {
    const contextualInEntries = bindRsglModule(parseRsgl([
      "template fields() { custom true }",
      "blockstate lamp { variants { use fields() } }"
    ].join("\n")));
    assert.ok(contextualInEntries.diagnostics.some(item =>
      item.code === "rsgl.templateOutputDialectRequired"
    ));

    const resourceBodyUsesResources = bindRsglModule(parseRsgl([
      "template factory() { model block generated {} }",
      "template invalidBody() { custom true\nuse factory() }"
    ].join("\n")));
    assert.ok(resourceBodyUsesResources.diagnostics.some(item =>
      item.code === "rsgl.conflictingResolvedTemplateOutputDialects"
      && item.message.includes("invalidBody")
    ));

    const completeResources = bindRsglModule(parseRsgl([
      "template modelPart() -> model { texture layer0 minecraft:block/stone }",
      "template tableFactory() { table values { key: true } }",
      "template factory() {",
      "  model block generated {}",
      "  use modelPart()",
      "}"
    ].join("\n")));
    assert.deepStrictEqual(templateMetadata(completeResources, "factory"), {
      outputSource: "noArrowResources",
      outputDialect: "resources"
    });
    assert.deepStrictEqual(templateMetadata(completeResources, "tableFactory"), {
      outputSource: "noArrowResources",
      outputDialect: "resources"
    });
    assert.ok(completeResources.diagnostics.some(item =>
      item.code === "rsgl.templateOutputDialectMismatch"
      && item.message.includes("modelPart")
    ));
  });

  it("preserves parser dialect conflicts when program linking rebuilds semantic conflicts", () => {
    const fileName = path.resolve("pack", "mixed-syntax.rsgl");
    const program = bindRsglProgram([{
      fileName,
      module: parseRsgl([
        "template mixedBody() {",
        "  texture all minecraft:block/stone",
        "  layer humanoid",
        "}"
      ].join("\n"))
    }]);

    assert.ok(program.fileDiagnostics.some(item =>
      item.fileName === fileName
      && item.code === "rsgl.conflictingLegacyTemplateBodyDialects"
    ));
  });

  it("compiles explicit model templates with nested model-dialect control flow", () => {
    const result = compileSourceWithUncheckedExterns([
      "template hopperBowl(tex: TextureId) -> model {",
      "  for y in [0, 8] {",
      "    if true {",
      "      element from [0, y, 0] to [16, y + 4, 16] { face up texture tex }",
      "    }",
      "  }",
      "}",
      "model block hopper { use hopperBowl(minecraft:block/hopper_inside) }"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(item => item.code), []);
    const model = generatedResourceUnits(result)[0];
    const content = model.content as { elements: Array<{ faces: { up: { texture: string } } }> };
    assert.strictEqual(content.elements.length, 2);
    assert.deepStrictEqual(content.elements[0].faces.up, {
      texture: "minecraft:block/hopper_inside"
    });
    const definitionMapping = model.sourceMap.mappings.find(mapping => mapping.generatedPath === "/elements/0");
    assert.ok(definitionMapping?.expansionStack.some(frame => frame.label === "use hopperBowl"));
    assert.strictEqual(definitionMapping?.expansionStack[0]?.sourceFile, "<anonymous>");
  });

  it("compiles public variants and multipart templates without legacy wrappers", () => {
    const result = compileSourceWithUncheckedExterns([
      "template stateSequence(model: ModelId) -> variants {",
      "  for powered in [false, true] { { powered: powered }: { model: model } }",
      "}",
      "template fenceParts(model: ModelId) -> multipart {",
      "  apply { model: model }",
      "}",
      "blockstate variants lamp { use stateSequence(minecraft:block/lamp) }",
      "blockstate multipart fence { use fenceParts(minecraft:block/fence_post) }"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(item => item.code), []);
    const [lamp, fence] = generatedResourceUnits(result);
    assert.deepStrictEqual(lamp.content, {
      variants: {
        "powered=false": { model: "minecraft:block/lamp" },
        "powered=true": { model: "minecraft:block/lamp" }
      }
    });
    assert.deepStrictEqual(fence.content, {
      multipart: [{ apply: { model: "minecraft:block/fence_post" } }]
    });
  });

  it("rejects wrong public dialects during semantic analysis", () => {
    const program = bindRsglProgram([{
      fileName: path.resolve("pack", "wrong-dialect.rsgl"),
      module: parseRsgl([
        "template variantsOnly() -> variants { {}: { model: minecraft:block/stone } }",
        "blockstate multipart wrong { use variantsOnly() }"
      ].join("\n"))
    }]);

    assert.ok(program.diagnostics.some(item => item.code === "rsgl.blockstateModeConflict"));
  });

  it("preserves explicit metadata through import aliases and re-exports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const files = [
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { states as importedStates } from \"./barrel.rsgl\"",
          "blockstate variants lamp { use importedStates(minecraft:block/lamp) }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { stateSequence as states } from \"./definitions.rsgl\"")
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { stateSequence }",
          "template stateSequence(model: ModelId) -> variants {",
          "  {}: { model: model }",
          "}"
        ].join("\n"))
      }
    ];
    const program = bindRsglProgram(files);
    const imported = program.models[0].scope.symbols.get("importedStates");

    assert.deepStrictEqual(imported?.signature?.templateOutput, {
      outputSource: "explicitArrow",
      outputDialect: "variants"
    });
    const result = compileRsglProgram(files, withUncheckedExterns({ entryFileName: mainFile }));
    assert.deepStrictEqual(result.diagnostics.map(item => item.code), []);
    assert.deepStrictEqual(generatedResourceUnits(result)[0].content, {
      variants: { "": { model: "minecraft:block/lamp" } }
    });
    const mapping = generatedResourceUnits(result)[0].sourceMap.mappings.find(item => item.generatedPath === "/variants/");
    assert.strictEqual(mapping?.sourceFile, definitionsFile);
    assert.strictEqual(mapping?.expansionStack.at(-1)?.sourceFile, mainFile);
  });

  it("isolates legacy contextual dispatch and rejects it without a body context", () => {
    const bodyUse = compileSourceWithUncheckedExterns([
      "template fields(value: Json) { custom value }",
      "json \"assets/minecraft/custom/example.json\" { use fields(true) }"
    ]);
    assert.ok(bodyUse.diagnostics.some(item => item.code === "rsgl.implicitTemplateOutputDialect"));
    assert.deepStrictEqual(generatedResourceUnits(bodyUse)[0].content, { custom: true });

    const topLevelUse = compileSourceWithUncheckedExterns([
      "template ambiguous() { let value = true }",
      "use ambiguous()"
    ]);
    assert.ok(topLevelUse.diagnostics.some(item => item.code === "rsgl.templateOutputDialectRequired"));
    assert.deepStrictEqual(generatedResourceUnits(topLevelUse), []);
  });

  it("diagnoses recursive output adapters before compilation", () => {
    const result = compileSourceWithUncheckedExterns([
      "template a() { use b() }",
      "template b() { use a() }",
      "use a()"
    ]);

    assert.ok(result.diagnostics.some(item => item.code === "rsgl.templateRecursion"));
    assert.deepStrictEqual(generatedResourceUnits(result), []);

    const resourceBodyCycle = compileSourceWithUncheckedExterns([
      "template first() {",
      "  custom true",
      "  use second()",
      "}",
      "template second() {",
      "  custom false",
      "  use first()",
      "}",
      "model block cycle { use first() }"
    ]);
    assert.ok(resourceBodyCycle.diagnostics.some(item => item.code === "rsgl.templateRecursion"));
  });

  it("preserves TextureVariable and TextureRef values in model template sinks", () => {
    const result = compileSourceWithUncheckedExterns([
      "template layer(tex: TextureRef = \"#side\") -> model { texture layer0 tex }",
      "model block inherited {",
      "  extern var #side",
      "  use layer()",
      "}",
      "model block concrete { use layer(minecraft:block/stone) }"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(item => item.code), []);
    const [inherited, concrete] = generatedResourceUnits(result);
    assert.deepStrictEqual(inherited.content, { textures: { layer0: "#side" } });
    assert.deepStrictEqual(concrete.content, { textures: { layer0: "minecraft:block/stone" } });
  });

  it("rejects malformed texture variables and non-model texture-variable sinks", () => {
    const malformed = compileSourceWithUncheckedExterns([
      "template layer(tex: TextureRef) -> model { texture layer0 tex }",
      "model block broken { use layer(\"#\") }"
    ]);
    assert.ok(malformed.diagnostics.some(item => item.code === "rsgl.invalidTextureVariable"));

    const wrongIdType = compileSourceWithUncheckedExterns([
      "template layer(tex: TextureId) -> model { texture layer0 tex }",
      "model block broken { use layer(\"#side\") }"
    ]);
    assert.ok(wrongIdType.diagnostics.some(item => item.code === "rsgl.textureVariableInvalidContext"));

    const wrongSink = compileSourceWithUncheckedExterns([
      "let side: TextureVariable = \"#side\"",
      "json \"assets/minecraft/custom/value.json\" { value side }"
    ]);
    assert.ok(wrongSink.diagnostics.some(item => item.code === "rsgl.textureVariableInvalidContext"));

    const mainFile = path.resolve("pack", "main.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const imported = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { layer } from \"./definitions.rsgl\"",
          "model block broken { use layer(\"#\") }"
        ].join("\n"))
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { layer }",
          "template layer(tex: TextureRef) -> model { texture layer0 tex }"
        ].join("\n"))
      }
    ]);
    assert.ok(imported.fileDiagnostics.some(item =>
      item.fileName === mainFile
      && item.code === "rsgl.invalidTextureVariable"
    ));

    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const importAllReExport = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import \"./barrel.rsgl\"",
          "model block broken { use layer(\"#\") }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { layer } from \"./definitions.rsgl\"")
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { layer }",
          "template layer(tex: TextureRef) -> model { texture layer0 tex }"
        ].join("\n"))
      }
    ]);
    assert.ok(importAllReExport.fileDiagnostics.some(item =>
      item.fileName === mainFile
      && item.code === "rsgl.invalidTextureVariable"
    ));
  });

  it("propagates TextureRef context through conditional and match result branches", () => {
    const localSource = [
      "template ref(tex: TextureRef) -> model { texture layer0 tex }",
      "template variable(tex: TextureVariable) -> model { texture layer0 tex }",
      "model block local {",
      "  use ref(true ? \"#\" : \"#\")",
      "  use variable(match true {",
      "    true -> \"#side\"",
      "    false -> minecraft:block/stone",
      "  })",
      "}"
    ].join("\n");
    const local = bindRsglModule(parseRsgl(localSource));
    const localMalformed = local.diagnostics.filter(item => item.code === "rsgl.invalidTextureVariable");
    const localMismatches = local.diagnostics.filter(item => item.code === "rsgl.typeMismatch");

    assert.strictEqual(localMalformed.length, 2);
    assert.ok(localMalformed.every(item => localSource.slice(item.range.start, item.range.end) === "\"#\""));
    assert.strictEqual(localMismatches.length, 1);
    assert.ok(localMismatches[0].message.includes("TextureVariable | TextureId"));

    const mainFile = path.resolve("pack", "main.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const mainSource = [
      "import \"./definitions.rsgl\"",
      "model block imported {",
      "  let selectMalformed = true",
      "  use ref(match selectMalformed {",
      "    true -> true ? \"#\" : \"#\"",
      "    false -> \"#side\"",
      "  })",
      "  use variable(true ? \"#side\" : minecraft:block/stone)",
      "}"
    ].join("\n");
    const imported = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { ref, variable }",
          "template ref(tex: TextureRef) -> model { texture layer0 tex }",
          "template variable(tex: TextureVariable) -> model { texture layer0 tex }"
        ].join("\n"))
      }
    ]);
    const importedDiagnostics = imported.fileDiagnostics.filter(item => item.fileName === mainFile);
    const importedMalformed = importedDiagnostics.filter(item => item.code === "rsgl.invalidTextureVariable");
    const importedMismatches = importedDiagnostics.filter(item => item.code === "rsgl.typeMismatch");

    assert.strictEqual(importedMalformed.length, 2);
    assert.ok(importedMalformed.every(item => mainSource.slice(item.range.start, item.range.end) === "\"#\""));
    assert.strictEqual(importedMismatches.length, 1);
    assert.ok(importedMismatches[0].message.includes("TextureVariable | TextureId"));
  });

  it("separates template use from ordinary function calls and body helpers", () => {
    const templateCall = bindRsglModule(parseRsgl([
      "template make() { model block made {} }",
      "let value = make()"
    ].join("\n")));
    assert.ok(templateCall.diagnostics.some(item => item.code === "rsgl.templateRequiresUse"));

    const functionUse = bindRsglModule(parseRsgl([
      "let mapper = value => value",
      "use mapper(true)"
    ].join("\n")));
    assert.ok(functionUse.diagnostics.some(item => item.code === "rsgl.functionValueCannotUse"));

    const helperUse = bindRsglModule(parseRsgl("model block wrong { use atlasDirectory(\"block\") }"));
    assert.ok(helperUse.diagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"));
  });

  it("enforces legacy blockstate producer capabilities as a subset of the caller", () => {
    const rootInsideEntries = bindRsglModule(parseRsgl([
      "template root() {",
      "  variants { [lit=true] -> { model: minecraft:block/lamp } }",
      "}",
      "blockstate lamp { variants { use root() } }"
    ].join("\n")));
    assert.ok(rootInsideEntries.diagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"));

    const entriesInsideRoot = bindRsglModule(parseRsgl([
      "template entries() -> variants { [lit=true] -> { model: minecraft:block/lamp } }",
      "template legacy() { use entries() }",
      "blockstate lamp { use legacy() }"
    ].join("\n")));
    assert.ok(!entriesInsideRoot.diagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"));
    assert.ok(entriesInsideRoot.diagnostics.some(item => item.code === "rsgl.implicitTemplateOutputDialect"));
  });

  it("propagates concrete callers through contextual adapters", () => {
    const conflictingDefinition = bindRsglModule(parseRsgl([
      "template modelPart() -> model { texture layer0 minecraft:block/stone }",
      "template variantPart() -> variants { [lit=true] -> { model: minecraft:block/lamp } }",
      "template outer() {",
      "  custom true",
      "  use modelPart()",
      "  use variantPart()",
      "}",
      "model block lamp { use outer() }"
    ].join("\n")));
    assert.ok(conflictingDefinition.diagnostics.some(item =>
      item.code === "rsgl.conflictingResolvedTemplateOutputDialects"
      && item.message.includes("outer")
    ));
    assert.ok(!conflictingDefinition.diagnostics.some(item =>
      item.code === "rsgl.templateOutputDialectMismatch"
      && item.message.includes("variantPart")
    ));

    const nestedAdapters = bindRsglModule(parseRsgl([
      "template inner() { inner true }",
      "template outer() { use inner() }",
      "json \"assets/minecraft/custom/example.json\" { use outer() }"
    ].join("\n")));
    const compatibilityWarnings = nestedAdapters.diagnostics.filter(item =>
      item.code === "rsgl.implicitTemplateOutputDialect"
    );
    assert.strictEqual(compatibilityWarnings.length, 2);
    assert.ok(!nestedAdapters.diagnostics.some(item => item.code === "rsgl.templateOutputDialectRequired"));
  });

  it("reclassifies reversed imported evidence without provisional-context cascades", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const adapterFile = path.resolve("pack", "adapter.rsgl");
    const partsFile = path.resolve("pack", "parts.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { adapter as importedAdapter } from \"./adapter.rsgl\"",
          "model block lamp { use importedAdapter() }"
        ].join("\n"))
      },
      {
        fileName: adapterFile,
        module: parseRsgl([
          "import { modelPart as importedModel } from \"./parts.rsgl\"",
          "export { top as adapter }",
          "template top() { use middle() }",
          "template middle() { use outer() }",
          "template outer() {",
          "  special base minecraft:item/shield model { type: minecraft:shield }",
          "  use importedModel()",
          "}"
        ].join("\n"))
      },
      {
        fileName: partsFile,
        module: parseRsgl([
          "export { modelPart }",
          "template modelPart() -> model { texture layer0 minecraft:block/stone }"
        ].join("\n"))
      }
    ]);

    const conflict = program.fileDiagnostics.find(item =>
      item.code === "rsgl.conflictingResolvedTemplateOutputDialects"
      && item.message.includes("outer")
    );
    assert.strictEqual(conflict?.fileName, adapterFile);
    const importedAdapter = program.models[0].scope.symbols.get("importedAdapter");
    assert.deepStrictEqual(importedAdapter?.signature?.templateOutput, {
      outputSource: "legacyContextualAdapter",
      bodyNodeKind: "Block"
    });
    assert.ok(importedAdapter?.signature?.templateOutputConflict);
    assert.ok(!program.fileDiagnostics.some(item =>
      item.code === "rsgl.templateOutputDialectMismatch"
      && item.message.includes("importedModel")
    ));
  });

  it("defers contextual texture sinks until their concrete caller is known", () => {
    const model = bindRsglModule(parseRsgl([
      "template layer(tex: TextureRef) { textures { layer0: tex } }",
      "model block inherited {",
      "  extern var #side",
      "  use layer(\"#side\")",
      "}"
    ].join("\n")));
    assert.ok(!model.diagnostics.some(item => item.code === "rsgl.textureVariableInvalidContext"));

    const json = bindRsglModule(parseRsgl([
      "template layer(tex: TextureRef) { textures { layer0: tex } }",
      "json \"assets/minecraft/custom/example.json\" { use layer(\"#side\") }"
    ].join("\n")));
    assert.ok(json.diagnostics.some(item => item.code === "rsgl.textureVariableInvalidContext"));
  });

  it("freezes use and contextual sink scopes at their source positions", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { modelPart as fragment, side } from \"./definitions.rsgl\"",
          "model block stable_use {",
          "  use fragment()",
          "  let fragment = value => value",
          "}",
          "template fields() {",
          "  textures { layer0: side }",
          "  let side: String = \"late shadow\"",
          "}",
          "json \"assets/minecraft/custom/value.json\" { use fields() }"
        ].join("\n"))
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { modelPart, side }",
          "template modelPart() -> model { texture layer0 minecraft:block/stone }",
          "let side: TextureVariable = \"#side\""
        ].join("\n"))
      }
    ]);

    assert.ok(!program.fileDiagnostics.some(item =>
      item.code === "rsgl.functionValueCannotUse"
      && item.fileName === mainFile
    ));
    assert.ok(program.fileDiagnostics.some(item =>
      item.code === "rsgl.textureVariableInvalidContext"
      && item.fileName === mainFile
    ));
  });

  it("retains non-call use diagnostics in linked programs", () => {
    const fileName = path.resolve("pack", "function-use.rsgl");
    const program = bindRsglProgram([{
      fileName,
      module: parseRsgl("let mapper = value => value\nuse mapper")
    }]);
    assert.ok(program.fileDiagnostics.some(item => item.code === "rsgl.functionValueCannotUse"));
  });

  it("links reversed named-import local re-export chains to a fixed point", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { forwarded as importedStates } from \"./barrel.rsgl\"",
          "model block wrong { use importedStates() }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl([
          "import { states as localStates } from \"./definitions.rsgl\"",
          "export { localStates as forwarded }"
        ].join("\n"))
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { states }",
          "template states() -> variants { {} -> { model: minecraft:block/lamp } }"
        ].join("\n"))
      }
    ]);

    assert.deepStrictEqual(program.models[0].scope.symbols.get("importedStates")?.signature?.templateOutput, {
      outputSource: "explicitArrow",
      outputDialect: "variants"
    });
    assert.ok(program.fileDiagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"));
    assert.ok(!program.fileDiagnostics.some(item => item.code === "rsgl.missingImportedSymbol"));
  });

  it("links bare import-all through export-all barrels to a fixed point", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const middleFile = path.resolve("pack", "middle.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { states } from \"./barrel.rsgl\"",
          "blockstate lamp { use states() }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export * from \"./middle.rsgl\"")
      },
      {
        fileName: middleFile,
        module: parseRsgl("import \"./definitions.rsgl\"")
      },
      {
        fileName: definitionsFile,
        module: parseRsgl("template states() -> variants { {} -> { model: minecraft:block/lamp } }")
      }
    ]);

    assert.deepStrictEqual(program.models[0].scope.symbols.get("states")?.signature?.templateOutput, {
      outputSource: "explicitArrow",
      outputDialect: "variants"
    });
    assert.ok(!program.fileDiagnostics.some(item => item.code === "rsgl.missingImportedSymbol"));
  });
});

function templateMetadata(model: RsglSemanticModel, name: string) {
  const symbol = model.scope.symbols.get(name);
  assert.ok(symbol?.node && symbol.signature?.templateOutput, `Expected template symbol '${name}'.`);
  return resolvedTemplateOutputMetadata({
    node: symbol.node as Extract<typeof symbol.node, { kind: "TemplateDecl" }>,
    outputMetadata: symbol.signature.templateOutput
  });
}
