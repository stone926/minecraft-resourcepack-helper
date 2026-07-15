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
  it("freezes declaration-driven output metadata on template signatures", () => {
    const model = bindRsglModule(parseRsgl([
      "template resources() { model block stone {} }",
      "template modelBody() -> model { parent minecraft:block/cube_all }",
      "template variantEntries() -> variants { case { lit: true } => minecraft:block/lamp }",
      "template multipartEntries() -> multipart { part always => minecraft:block/post }"
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

  it("compiles public variants and multipart templates", () => {
    const result = compileSourceWithUncheckedExterns([
      "template stateSequence(model: ModelId) -> variants {",
      "  for powered in [false, true] { case { powered } => model }",
      "}",
      "template fenceParts(model: ModelId) -> multipart {",
      "  part always => model",
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
        "template variantsOnly() -> variants { case * => minecraft:block/stone }",
        "blockstate multipart wrong { use variantsOnly() }"
      ].join("\n"))
    }]);

    assert.ok(program.diagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"));
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
          "  case * => model",
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

  it("diagnoses recursive templates before compilation", () => {
    const result = compileSourceWithUncheckedExterns([
      "template a() { use b() }",
      "template b() { use a() }",
      "use a()"
    ]);

    assert.ok(result.diagnostics.some(item => item.code === "rsgl.templateRecursion"));
    assert.deepStrictEqual(generatedResourceUnits(result), []);

    const resourceBodyCycle = compileSourceWithUncheckedExterns([
      "template first() -> model {",
      "  custom true",
      "  use second()",
      "}",
      "template second() -> model {",
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
          "template states() -> variants { case * => minecraft:block/lamp }"
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

});

function templateMetadata(model: RsglSemanticModel, name: string) {
  const symbol = model.scope.symbols.get(name);
  assert.ok(symbol?.node && symbol.signature?.templateOutput, `Expected template symbol '${name}'.`);
  return resolvedTemplateOutputMetadata({
    node: symbol.node as Extract<typeof symbol.node, { kind: "TemplateDecl" }>,
    outputMetadata: symbol.signature.templateOutput
  });
}
