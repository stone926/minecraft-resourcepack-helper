import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglFile,
  compileRsglModule,
  compileRsglProgram,
  loadRsglSourceFilesFromFile,
  type JsonValue
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { bindRsglProgram } from "../../src/semantic";
import { generatedResourceUnits, withUncheckedExterns } from "./helpers/compile";
import { withTempDir } from "./helpers/fs";

describe("RSGL unsupported default imports", () => {
  it("preserves the default-import recovery AST without swallowing following statements", () => {
    const valid = parseRsgl([
      "import common from \"./common.rsgl\"",
      "let after = 1"
    ].join("\n"));
    const validImport = valid.statements[0];

    assert.deepStrictEqual(valid.statements.map(statement => statement.kind), ["ImportDecl", "LetDecl"]);
    assert.strictEqual(validImport.kind, "ImportDecl");
    if (validImport.kind === "ImportDecl") {
      assert.deepStrictEqual(valid.diagnostics, [{
        code: "rsgl.unsupportedDefaultImport",
        message: "Default imports are not supported; use a named import.",
        range: validImport.defaultName?.range,
        severity: "error"
      }]);
      assert.strictEqual(validImport.defaultName?.text, "common");
      assert.deepStrictEqual(validImport.namedImports, []);
      assert.strictEqual(validImport.source?.value, "./common.rsgl");
    }

    const incomplete = parseRsgl([
      "import common from",
      "let after = 1"
    ].join("\n"));
    const incompleteImport = incomplete.statements[0];
    assert.deepStrictEqual(incomplete.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unsupportedDefaultImport",
      "rsgl.expectedImportSource"
    ]);
    assert.deepStrictEqual(incomplete.statements.map(statement => statement.kind), ["ImportDecl", "LetDecl"]);
    assert.strictEqual(incompleteImport.kind, "ImportDecl");
    if (incompleteImport.kind === "ImportDecl") {
      assert.strictEqual(incompleteImport.defaultName?.text, "common");
      assert.strictEqual(incompleteImport.source, null);
    }

    const supported = parseRsgl([
      "import \"./side-effect.rsgl\"",
      "import { stone as rock } from \"./common.rsgl\""
    ].join("\n"));
    const bareImport = supported.statements[0];
    const namedImport = supported.statements[1];
    assert.deepStrictEqual(supported.diagnostics, []);
    assert.strictEqual(bareImport.kind, "ImportDecl");
    assert.strictEqual(namedImport.kind, "ImportDecl");
    if (bareImport.kind === "ImportDecl" && namedImport.kind === "ImportDecl") {
      assert.strictEqual(bareImport.defaultName, undefined);
      assert.deepStrictEqual(bareImport.namedImports, []);
      assert.strictEqual(namedImport.defaultName, undefined);
      assert.deepStrictEqual(namedImport.namedImports.map(item => [item.imported.text, item.local.text]), [
        ["stone", "rock"]
      ]);
    }
  });

  it("reports one precise semantic diagnostic without defining a pseudo symbol", () => {
    const { files, mainFile, mainModule } = defaultImportProgram();
    const defaultImport = mainModule.statements[0];
    const program = bindRsglProgram(files);
    const mainModel = program.models.find(model => model.fileName === mainFile);

    assert.strictEqual(defaultImport.kind, "ImportDecl");
    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unsupportedDefaultImport"
    ]);
    assert.strictEqual(program.fileDiagnostics.length, 1);
    assert.strictEqual(program.fileDiagnostics[0].fileName, mainFile);
    if (defaultImport.kind === "ImportDecl") {
      assert.deepStrictEqual(program.fileDiagnostics[0].range, defaultImport.defaultName?.range);
    }
    assert.ok(mainModel);
    assert.strictEqual(mainModel.scope.symbols.has("common"), false);
    assert.strictEqual(mainModel.scope.symbols.has("stone"), false);
    assert.strictEqual(mainModel.symbols.some(symbol => symbol.name === "common"), false);
    assert.strictEqual(mainModel.references.find(reference => reference.name === "common")?.symbol, undefined);
    assert.strictEqual(mainModel.imports[0].defaultName, "common");
    assert.strictEqual(mainModel.imports[0].importAll, false);
    assert.deepStrictEqual(mainModel.imports[0].namedImports, []);
    assert.strictEqual(program.importGraph.edges.some(edge => edge.from === mainFile), true);
  });

  it("blocks program compilation before a default import can emit null content", () => {
    const { files, mainFile } = defaultImportProgram();
    const result = compileRsglProgram(files, withUncheckedExterns({ entryFileName: mainFile }));
    const units = generatedResourceUnits(result);

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unsupportedDefaultImport"
    ]);
    assert.strictEqual(units.some(unit => containsNull(unit.content as JsonValue)), false);
    assert.deepStrictEqual(units, []);
  });

  it("blocks the standalone module compile path with the same diagnostic", () => {
    const source = [
      "import common from \"./common.rsgl\"",
      "json \"assets/minecraft/default-import.json\" {",
      "  imported: common.value",
      "}"
    ].join("\n");
    const result = compileRsglModule(parseRsgl(source), withUncheckedExterns({
      fileName: path.resolve("default-import", "standalone.rsgl")
    }));

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unsupportedDefaultImport"
    ]);
    assert.deepStrictEqual(generatedResourceUnits(result), []);
  });

  it("loads the filesystem import closure but never compiles a damaged unit", () => {
    withTempDir(root => {
      const mainFile = path.join(root, "含 空格", "main.rsgl");
      const commonFile = path.join(root, "含 空格", "common.rsgl");
      fs.mkdirSync(path.dirname(mainFile), { recursive: true });
      fs.writeFileSync(mainFile, [
        "import common from \"./common.rsgl\"",
        "model block default_import {",
        "  textures { all: common.stone }",
        "}"
      ].join("\n"));
      fs.writeFileSync(commonFile, "let stone = minecraft:block/stone\nexport { stone }");

      assert.deepStrictEqual(loadRsglSourceFilesFromFile(mainFile).map(file => file.fileName).sort(), [
        path.normalize(path.resolve(mainFile)),
        path.normalize(path.resolve(commonFile))
      ].sort());

      const result = compileRsglFile(mainFile, withUncheckedExterns({}));
      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
        "rsgl.unsupportedDefaultImport"
      ]);
      assert.deepStrictEqual(generatedResourceUnits(result), []);
    });
  });
});

function defaultImportProgram() {
  const mainFile = path.resolve("default-import", "main.rsgl");
  const commonFile = path.resolve("default-import", "common.rsgl");
  const mainModule = parseRsgl([
    "import common from \"./common.rsgl\"",
    "model block default_import {",
    "  textures { all: common.stone }",
    "}"
  ].join("\n"));
  return {
    mainFile,
    mainModule,
    files: [
      { fileName: mainFile, module: mainModule },
      {
        fileName: commonFile,
        module: parseRsgl([
          "let stone = minecraft:block/stone",
          "export { stone }"
        ].join("\n"))
      }
    ]
  };
}

function containsNull(value: JsonValue): boolean {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsNull);
  }
  if (typeof value === "object") {
    return Object.values(value).some(containsNull);
  }
  return false;
}
