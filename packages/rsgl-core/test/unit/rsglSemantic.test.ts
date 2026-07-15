import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram } from "../../src/semantic";

describe("RSGL semantic model", () => {
  it("builds symbols, references, imports, and output resource previews", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "namespace minecraft",
      "import { woods as woodTable } from \"./woods.rsgl\"",
      "let id: TextureId = minecraft:block/acacia_planks",
      "template cube(id: ResourceId, texture: TextureId = minecraft:block/acacia_planks) {",
      "  model block id {",
      "    parent minecraft:block/cube_all",
      "    textures { all: texture }",
      "  }",
      "}",
      "template cubeFields(parentModel: ModelId, texture: TextureId) -> model {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}",
      "model block acacia_planks {",
      "  parent minecraft:block/cube_all",
      "  textures { all: id }",
      "}",
      "blockstate variants acacia_stairs {",
      "  case * => minecraft:block/acacia_stairs",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module, { fileName: path.join("pack", "main.rsgl") });

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(model.namespace, "minecraft");
    assert.ok(model.symbols.some(symbol => symbol.kind === "template" && symbol.name === "cube"));
    assert.ok(model.symbols.some(symbol => symbol.kind === "template" && symbol.name === "cubeFields"));
    assert.ok(model.symbols.some(symbol => symbol.kind === "variable" && symbol.name === "id"));
    assert.strictEqual(model.imports[0].source, "./woods.rsgl");
    assert.deepStrictEqual(model.imports[0].namedImports.map(item => item.local), ["woodTable"]);
    assert.ok(model.references.some(reference => reference.name === "id" && reference.symbol?.kind === "variable"));
    assert.ok(model.outputResources.some(resource => resource.kind === "model" && resource.id === "acacia_planks"));
    assert.ok(model.outputResources.some(resource => resource.kind === "blockstate" && resource.id === "acacia_stairs"));
  });

  it("checks expressions in model geometry statements", () => {
    const source = [
      "model block semantic_geometry {",
      "  texture wall missingTexture",
      "  box from missingFrom to missingTo shade missingShade {",
      "    north texture missingFace",
      "  }",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));

    const undefinedNames = model.diagnostics
      .filter(diagnostic => diagnostic.code === "rsgl.undefinedSymbol")
      .map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end))
      .sort();
    assert.deepStrictEqual(undefinedNames, [
      "missingFace",
      "missingFrom",
      "missingShade",
      "missingTexture",
      "missingTo"
    ]);
  });

  it("reports duplicate symbols, undefined symbols, and simple type mismatches", () => {
    const module = parseRsgl([
      "let count: Number = \"many\"",
      "let count = 2",
      "model block example {",
      "  textures { all: missingTexture }",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module);
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.typeMismatch"));
    assert.ok(codes.includes("rsgl.duplicateSymbol"));
    assert.ok(codes.includes("rsgl.undefinedSymbol"));
  });

  it("treats bare identifiers in for-in list literals as string constants", () => {
    const module = parseRsgl([
      "for wood in [oak, spruce, birch] {",
      "  model block `${wood}_planks` {",
      "    textures { all: `minecraft:block/${wood}_planks` }",
      "  }",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module);

    assert.strictEqual(model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"), false);
  });

  it("binds named seq generators and padding arguments", () => {
    const model = bindRsglModule(parseRsgl([
      "let textures = seq(i => `minecraft:particle/spark_${i}`, i: 0..2, pad: 2)"
    ].join("\n")));

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.ok(model.references.some(reference => reference.name === "i" && reference.symbol?.kind === "parameter"));
  });

  it("does not record extern declarations as semantic output resources", () => {
    const model = bindRsglModule(parseRsgl([
      "extern custom model minecraft:block/stone",
      "extern custom blockstate minecraft:stone",
      "extern custom item minecraft:stone",
      "extern custom texture minecraft:block/stone",
      "extern custom texture_directory minecraft:block/**",
      "extern custom sound minecraft:block/stone/break1",
      "extern custom font minecraft:default",
      "extern custom font_file minecraft:font/ascii.png",
      "extern custom shader_vertex minecraft:core/screenquad",
      "extern custom shader_fragment minecraft:post/box_blur"
    ].join("\n")));

    assert.deepStrictEqual(model.diagnostics, []);
    assert.deepStrictEqual(model.outputResources, []);
  });

  it("rejects unsupported extern kinds before recording semantic resource previews", () => {
    const model = bindRsglModule(parseRsgl("extern custom atlas minecraft:blocks"));

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), ["rsgl.invalidExternKind"]);
    assert.deepStrictEqual(model.outputResources, []);
  });

  it("reports template string interpolation diagnostics at embedded expression ranges", () => {
    const source = "let label = `minecraft:block/${missing.value}`";
    const model = bindRsglModule(parseRsgl(source));
    const diagnostic = model.diagnostics.find(item => item.code === "rsgl.undefinedSymbol");

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "missing");
  });

  it("warns when match expressions over finite domains are not exhaustive", () => {
    const model = bindRsglModule(parseRsgl([
      "for dir in HORIZONTAL {",
      "  let model = match dir {",
      "    north -> \"north\"",
      "    west -> \"west\"",
      "  }",
      "}"
    ].join("\n")));

    const diagnostic = model.diagnostics.find(item => item.code === "rsgl.nonExhaustiveMatch");
    assert.ok(diagnostic);
    assert.strictEqual(diagnostic.severity, "warning");
    assert.ok(diagnostic.message.includes("east"));
    assert.ok(diagnostic.message.includes("south"));

    const withFallback = bindRsglModule(parseRsgl([
      "for dir in HORIZONTAL {",
      "  let model = match dir {",
      "    north -> \"north\"",
      "    _ -> \"other\"",
      "  }",
      "}"
    ].join("\n")));
    assert.strictEqual(withFallback.diagnostics.some(item => item.code === "rsgl.nonExhaustiveMatch"), false);
  });

  it("derives match domains from literal unions and record members", () => {
    const model = bindRsglModule(parseRsgl([
      "let direct: \"active\" | \"inactive\" = \"active\"",
      "let directResult = match direct { \"active\" -> 1 }",
      "type State = { kind: \"ready\" | \"waiting\" }",
      "let state: State = { kind: \"ready\" }",
      "let memberResult = match state.kind { \"ready\" -> 1 }"
    ].join("\n")));
    const diagnostics = model.diagnostics.filter(item => item.code === "rsgl.nonExhaustiveMatch");

    assert.strictEqual(diagnostics.length, 2);
    assert.ok(diagnostics[0].message.includes("inactive"));
    assert.ok(diagnostics[1].message.includes("waiting"));
  });

  it("checks builtin helper signatures", () => {
    const module = parseRsgl([
      "equipment minecraft:bad_equipment {",
      "  use equipmentLayers(texture: minecraft:iron)",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module);
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.missingArgument"));
    assert.strictEqual(codes.filter(code => code === "rsgl.missingArgument").length, 1);
  });

  it("checks lambda arity and purity diagnostics", () => {
    const model = bindRsglModule(parseRsgl([
      "let wrongArity = (value => value)(\"one\", \"two\")",
      "let impure = value => glob(\"./fragment.json\")"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.lambdaArityMismatch"));
    assert.ok(codes.includes("rsgl.lambdaImpureCall"));
  });

  it("infers unannotated let bindings from their initializers", () => {
    const model = bindRsglModule(parseRsgl([
      "let toModel = value => value",
      "let resolved = toModel(1)"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.includes("rsgl.notCallable"), false);
    assert.strictEqual(model.scope.symbols.get("toModel")?.type.kind, "Function");
  });

  it("infers local let lambda bindings as callable", () => {
    const model = bindRsglModule(parseRsgl([
      "model block ruby {",
      "  let toModel = value => `minecraft:block/${value}`",
      "  parent toModel(1)",
      "}"
    ].join("\n")));

    assert.strictEqual(model.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.notCallable"), false);
  });

  it("keeps explicit let annotations over inferred initializer types", () => {
    const model = bindRsglModule(parseRsgl([
      "let count: Number = \"nope\""
    ].join("\n")));

    assert.ok(model.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.typeMismatch"));
    assert.strictEqual(model.scope.symbols.get("count")?.type.kind, "Number");
  });

  it("does not clobber annotated let types from duplicate declarations", () => {
    const model = bindRsglModule(parseRsgl([
      "let count: Number = 1",
      "let count = \"hello\"",
      "let use_it: Number = count"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.duplicateSymbol"));
    assert.strictEqual(codes.includes("rsgl.typeMismatch"), false);
    assert.strictEqual(model.scope.symbols.get("count")?.type.kind, "Number");
  });

  it("flags impure calls in dynamic state keys inside lambdas", () => {
    const model = bindRsglModule(parseRsgl([
      "let mk = m => [age = m, [glob(\"keys/*\")[0]] = m]"
    ].join("\n")));

    assert.ok(model.diagnostics.map(diagnostic => diagnostic.code).includes("rsgl.lambdaImpureCall"));
  });

  it("reports unknown, duplicate, and excessive template call arguments", () => {
    const module = parseRsgl([
      "template cube(id: TextureId, texture: TextureId = id) {",
      "  model block id { parent minecraft:block/cube_all }",
      "}",
      "use cube(",
      "  stone,",
      "  minecraft:block/stone,",
      "  minecraft:block/granite,",
      "  id: dirt,",
      "  extra: minecraft:block/x,",
      "  extra: minecraft:block/y",
      ")"
    ].join("\n"));

    const model = bindRsglModule(module);
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
    assert.strictEqual(codes.includes("rsgl.undefinedSymbol"), false);
  });

  it("builds an import graph and reports missing imports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const woodsFile = path.resolve("pack", "woods.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { woods } from \"./woods.rsgl\"",
          "import \"./missing.rsgl\""
        ].join("\n"))
      },
      {
        fileName: woodsFile,
        module: parseRsgl("table woods { acacia: minecraft:block/acacia_planks }")
      }
    ]);

    assert.ok(program.importGraph.edges.some(edge => edge.from === mainFile && edge.to === woodsFile));
    assert.ok(program.importGraph.missing.some(missing => missing.source === "./missing.rsgl"));
    assert.ok(program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingImport"));
  });

  it("reports import cycles at the import source range", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const cycleFile = path.resolve("pack", "cycle.rsgl");
    const mainModule = parseRsgl([
      "let marker = 1",
      "import \"./cycle.rsgl\""
    ].join("\n"));
    const cycleModule = parseRsgl("import \"./main.rsgl\"");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: mainModule
      },
      {
        fileName: cycleFile,
        module: cycleModule
      }
    ]);

    const mainImport = mainModule.statements.find(statement => statement.kind === "ImportDecl");
    const cycleDiagnostic = program.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.importCycle"
      && diagnostic.range.start === mainImport?.source?.range.start
      && diagnostic.range.end === mainImport.source.range.end
    );

    assert.ok(cycleDiagnostic);
  });

  it("resolves named imports to target module symbols and signatures", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cube } from \"./templates.rsgl\"",
          "use cube(id: minecraft:block/stone)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: ResourceId) {",
          "  model block id { parent minecraft:block/cube_all }",
          "}",
          "export { cube }"
        ].join("\n"))
      }
    ]);

    const mainModel = program.models.find(model => model.fileName === mainFile);
    const importedCube = mainModel?.scope.symbols.get("cube");

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(importedCube?.kind, "import");
    assert.strictEqual(importedCube?.type.kind, "Function");
    assert.strictEqual(importedCube?.signature?.parameters[0].name, "id");
  });

  it("restricts named imports when a module has explicit exports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl("import { publicWoods, secretWoods } from \"./tables.rsgl\"")
      },
      {
        fileName: tablesFile,
        module: parseRsgl([
          "table publicWoods { acacia: minecraft:block/acacia_planks }",
          "table secretWoods { hidden: minecraft:block/barrier }",
          "export { publicWoods }"
        ].join("\n"))
      }
    ]);

    const codes = program.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.missingImportedSymbol"));
    assert.strictEqual(codes.filter(code => code === "rsgl.missingImportedSymbol").length, 1);
  });

  it("resolves re-exported template signatures", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cubeModel } from \"./barrel.rsgl\"",
          "use cubeModel(id: minecraft:block/stone)"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { cube as cubeModel } from \"./templates.rsgl\"")
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: ResourceId) {",
          "  model block id { parent minecraft:block/cube_all }",
          "}",
          "export { cube }"
        ].join("\n"))
      }
    ]);

    const mainModel = program.models.find(model => model.fileName === mainFile);
    const importedCube = mainModel?.scope.symbols.get("cubeModel");

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(importedCube?.signature?.parameters[0].name, "id");
  });

  it("resolves imported template signatures", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cubeFields } from \"./fragments.rsgl\"",
          "model block stone {",
          "  use cubeFields(parentModel: minecraft:block/cube_all)",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "template cubeFields(parentModel: ModelId, texture: TextureId) -> model {",
          "  parent parentModel",
          "  textures { all: texture }",
          "}",
          "export { cubeFields }"
        ].join("\n"))
      }
    ]);

    const mainModel = program.models.find(model => model.fileName === mainFile);
    const importedFragment = mainModel?.scope.symbols.get("cubeFields");
    const codes = program.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(importedFragment?.kind, "import");
    assert.strictEqual(importedFragment?.signature?.parameters[0].name, "parentModel");
    assert.ok(codes.includes("rsgl.missingArgument"));
  });

  it("validates imported template signatures inside blockstate sections", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const fragmentsFile = path.resolve("pack", "fragments.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { lampFacing } from \"./fragments.rsgl\"",
          "blockstate variants lamp {",
          "  use lampFacing()",
          "}"
        ].join("\n"))
      },
      {
        fileName: fragmentsFile,
        module: parseRsgl([
          "template lampFacing(modelId: ModelId) -> variants {",
          "  case { facing: north } => modelId",
          "}",
          "export { lampFacing }"
        ].join("\n"))
      }
    ]);

    assert.ok(program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingArgument"));
  });

  it("resolves export-star re-exports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const tablesFile = path.resolve("pack", "tables.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl("import { woods } from \"./barrel.rsgl\"")
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export * from \"./tables.rsgl\"")
      },
      {
        fileName: tablesFile,
        module: parseRsgl([
          "table woods { acacia: minecraft:block/acacia_planks }",
          "export { woods }"
        ].join("\n"))
      }
    ]);

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(program.importGraph.edges.some(edge => edge.from === barrelFile && edge.to === tablesFile), true);
  });

  it("reports named imports that are not exported by the target module", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl("import { missing } from \"./templates.rsgl\"")
      },
      {
        fileName: templatesFile,
        module: parseRsgl("let existing = 1")
      }
    ]);

    assert.ok(program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingImportedSymbol"));
    assert.ok(program.fileDiagnostics.some(diagnostic =>
      diagnostic.fileName === mainFile &&
      diagnostic.code === "rsgl.missingImportedSymbol"
    ));
  });

  it("checks resolved imported template call signatures", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cube } from \"./templates.rsgl\"",
          "use cube()"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: ResourceId) {",
          "  model block id { parent minecraft:block/cube_all }",
          "}",
          "export { cube }"
        ].join("\n"))
      }
    ]);

    assert.ok(program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingArgument"));
  });

  it("checks resolved imported template argument binding", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { cube } from \"./templates.rsgl\"",
          "use cube(",
          "  stone,",
          "  minecraft:block/stone,",
          "  minecraft:block/granite,",
          "  id: dirt,",
          "  extra: minecraft:block/x,",
          "  extra: minecraft:block/y",
          ")"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: TextureId, texture: TextureId = id) {",
          "  model block id { parent minecraft:block/cube_all }",
          "}",
          "export { cube }"
        ].join("\n"))
      }
    ]);

    const codes = program.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
  });

  it("finds imported calls inside for-in generator iterables", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { supply } from \"./templates.rsgl\"",
          "let values = seq(i => `${i}`, i in supply())"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl("template supply(id: ResourceId) { let value = id }\nexport { supply }")
      }
    ]);

    assert.strictEqual(
      program.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.missingArgument").length,
      1
    );
  });

  it("validates imported calls in every model geometry expression container", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { geometryValue } from \"./templates.rsgl\"",
          "model block linked_geometry {",
          "  texture wall geometryValue()",
          "  box from geometryValue() to geometryValue() shade geometryValue() {",
          "    north texture geometryValue()",
          "  }",
          "}"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template geometryValue(required: Number) { let value = required }",
          "export { geometryValue }"
        ].join("\n"))
      }
    ]);

    assert.strictEqual(
      program.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.missingArgument").length,
      5
    );
  });
});
