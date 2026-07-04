import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../rsgl/parser";
import { bindRsglModule, bindRsglProgram } from "../../rsgl/semantic";

describe("RSGL semantic model", () => {
  it("builds symbols, references, imports, and output resource previews", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "namespace minecraft",
      "import { woods as woodTable } from \"./woods.rsgl\"",
      "let id: ResourceId = minecraft:block/acacia_planks",
      "template cube(id: ResourceId, texture: TextureId = id) {",
      "  model block id {",
      "    parent minecraft:block/cube_all",
      "    textures { all: texture }",
      "  }",
      "}",
      "fragment cubeFields(parentModel: ModelId, texture: TextureId) {",
      "  parent parentModel",
      "  textures { all: texture }",
      "}",
      "model block acacia_planks {",
      "  parent minecraft:block/cube_all",
      "  textures { all: id }",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module, { fileName: path.join("pack", "main.rsgl") });

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(model.namespace, "minecraft");
    assert.ok(model.symbols.some(symbol => symbol.kind === "template" && symbol.name === "cube"));
    assert.ok(model.symbols.some(symbol => symbol.kind === "fragment" && symbol.name === "cubeFields"));
    assert.ok(model.symbols.some(symbol => symbol.kind === "variable" && symbol.name === "id"));
    assert.strictEqual(model.imports[0].source, "./woods.rsgl");
    assert.deepStrictEqual(model.imports[0].namedImports.map(item => item.local), ["woodTable"]);
    assert.ok(model.references.some(reference => reference.name === "id" && reference.symbol?.kind === "variable"));
    assert.ok(model.outputResources.some(resource => resource.kind === "model" && resource.id === "acacia_planks"));
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

  it("reports template string interpolation diagnostics at embedded expression ranges", () => {
    const source = "let label = `minecraft:block/${missing.value}`";
    const model = bindRsglModule(parseRsgl(source));
    const diagnostic = model.diagnostics.find(item => item.code === "rsgl.undefinedSymbol");

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "missing");
  });

  it("checks builtin template signatures", () => {
    const module = parseRsgl([
      "blockstate minecraft:bad_stairs {",
      "  use stairs(base: minecraft:block/base)",
      "}",
      "equipment minecraft:bad_equipment {",
      "  use equipmentLayers(texture: minecraft:iron)",
      "}"
    ].join("\n"));

    const model = bindRsglModule(module);
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.missingArgument"));
    assert.strictEqual(codes.filter(code => code === "rsgl.missingArgument").length, 3);
  });

  it("reports unknown, duplicate, and excessive template call arguments", () => {
    const module = parseRsgl([
      "template cube(id: ResourceId, texture: TextureId = id) {",
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
          "}"
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

  it("resolves imported fragment signatures", () => {
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
          "fragment cubeFields(parentModel: ModelId, texture: TextureId) {",
          "  parent parentModel",
          "  textures { all: texture }",
          "}"
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
          "}"
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
          "template cube(id: ResourceId, texture: TextureId = id) {",
          "  model block id { parent minecraft:block/cube_all }",
          "}"
        ].join("\n"))
      }
    ]);

    const codes = program.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.unknownArgument"));
    assert.ok(codes.includes("rsgl.tooManyArguments"));
    assert.ok(codes.includes("rsgl.duplicateArgument"));
  });
});
