import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import { resolveRsglCompileConfiguration } from "../../src/compiler/compileConfiguration";
import { createProgramCompileEnvironments } from "../../src/compiler/environment";
import {
  type EvaluationContext,
  evaluateExpression
} from "../../src/compiler/evaluate";
import {
  ModuleNamespaceValue,
  isModuleNamespaceValue
} from "../../src/compiler/moduleNamespaceValue";
import { parseRsgl } from "../../src/parser";
import { bindRsglProgram, type RsglSourceFile } from "../../src/semantic";
import {
  expectNoDiagnostics,
  unitByPath,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL module namespace runtime", () => {
  it("evaluates qualified values, lambdas, and templates through a re-export", () => {
    const root = path.resolve("module-namespace-runtime");
    const libraryFile = path.join(root, "library.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const librarySource = [
      "let VALUE: Number = 21",
      "let double: (Number) -> Number = value => value * 2",
      "template fields() -> model { from_template VALUE }",
      "export { VALUE, double, fields }"
    ].join("\n");
    const mainSource = [
      "import * as common from \"./barrel.rsgl\"",
      "model block namespace_runtime {",
      "  direct common.VALUE",
      "  called common.double(common.VALUE)",
      "  use common.fields()",
      "}"
    ].join("\n");
    const result = compileRsglProgram([
      sourceFile(mainFile, mainSource),
      sourceFile(barrelFile, "export * from \"./library.rsgl\""),
      sourceFile(libraryFile, librarySource)
    ], withUncheckedExterns({ entryFileName: mainFile }));

    expectNoDiagnostics(result);
    const unit = unitByPath(result, "models/block/namespace_runtime.json");
    assert.deepStrictEqual(unit.content, {
      direct: 21,
      called: 42,
      from_template: 21
    });

    const directMapping = unit.sourceMap.mappings.find(mapping => mapping.generatedPath === "/direct");
    assert.ok(directMapping);
    assert.strictEqual(directMapping.sourceFile, mainFile);
    assert.ok(
      mainSource.slice(directMapping.sourceRange.start, directMapping.sourceRange.end)
        .includes("common.VALUE")
    );
    const directOrigin = unit.validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/direct"
    );
    assert.ok(directOrigin);
    assert.strictEqual(directOrigin.sourceFile, libraryFile);
    assert.strictEqual(
      librarySource.slice(directOrigin.sourceRange.start, directOrigin.sourceRange.end),
      "21"
    );
  });

  it("dispatches every public template dialect and exact legacy metadata through a namespace", () => {
    const root = path.resolve("module-namespace-template-dialects");
    const mainFile = path.join(root, "main.rsgl");
    const libraryFile = path.join(root, "library.rsgl");
    const result = compileRsglProgram([
      sourceFile(mainFile, [
        "import * as common from \"./library.rsgl\"",
        "model block namespace_model { use common.modelPart() }",
        "model block namespace_legacy { use common.legacyModelPart() }",
        "blockstate variants namespace_variants { use common.variantsPart() }",
        "blockstate multipart namespace_multipart { use common.multipartPart() }"
      ].join("\n")),
      sourceFile(libraryFile, [
        "template modelPart() -> model { parent minecraft:block/cube_all }",
        "template variantsPart() -> variants { {}: minecraft:block/stone }",
        "template multipartPart() -> multipart { apply minecraft:block/post }",
        "template legacyModelPart() { parent minecraft:block/cube }",
        "export { modelPart, variantsPart, multipartPart, legacyModelPart }"
      ].join("\n"))
    ], withUncheckedExterns({ entryFileName: mainFile }));

    assert.deepStrictEqual(
      result.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
      []
    );
    assert.strictEqual(result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.implicitTemplateOutputDialect"
    ).length, 1);
    assert.deepStrictEqual(
      unitByPath(result, "models/block/namespace_model.json").content,
      { parent: "minecraft:block/cube_all" }
    );
    assert.deepStrictEqual(
      unitByPath(result, "models/block/namespace_legacy.json").content,
      { parent: "minecraft:block/cube" }
    );
    assert.deepStrictEqual(
      unitByPath(result, "blockstates/namespace_variants.json").content,
      { variants: { "": { model: "minecraft:block/stone" } } }
    );
    assert.deepStrictEqual(
      unitByPath(result, "blockstates/namespace_multipart.json").content,
      { multipart: [{ apply: { model: "minecraft:block/post" } }] }
    );
  });

  it("keeps namespace export maps live across import cycles", () => {
    const root = path.resolve("module-namespace-cycle");
    const mainFile = path.join(root, "main.rsgl");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const result = compileRsglProgram([
      sourceFile(mainFile, [
        "import * as common from \"./b.rsgl\"",
        "model block namespace_cycle { resolved common.readA() }"
      ].join("\n")),
      sourceFile(aFile, [
        "import * as common from \"./b.rsgl\"",
        "let readB: () -> Number = () => common.VALUE",
        "export { readB }"
      ].join("\n")),
      sourceFile(bFile, [
        "import * as common from \"./a.rsgl\"",
        "let VALUE: Number = 7",
        "let readA: () -> Number = () => common.readB()",
        "export { VALUE, readA }"
      ].join("\n"))
    ], withUncheckedExterns({ entryFileName: mainFile }));

    assert.deepStrictEqual(
      result.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.importCycle", "rsgl.importCycle"]
    );
    assert.deepStrictEqual(
      unitByPath(result, "models/block/namespace_cycle.json").content,
      { resolved: 7 }
    );
  });

  it("rejects namespace values at direct and nested JSON sink paths", () => {
    const root = path.resolve("module-namespace-json");
    const mainFile = path.join(root, "main.rsgl");
    const libraryFile = path.join(root, "library.rsgl");
    const result = compileRsglProgram([
      sourceFile(mainFile, [
        "import * as common from \"./library.rsgl\"",
        "json \"assets/example/direct.json\" { merge common }",
        "json \"assets/example/nested.json\" { namespace common }"
      ].join("\n")),
      sourceFile(libraryFile, "let VALUE = 1")
    ], withUncheckedExterns({ entryFileName: mainFile }));
    const namespaceDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.moduleNamespaceValueNotSerializable"
    );

    assert.strictEqual(namespaceDiagnostics.length, 2);
    assert.ok(namespaceDiagnostics.some(diagnostic => diagnostic.message.includes("'<root>'")));
    assert.ok(namespaceDiagnostics.some(diagnostic => diagnostic.message.includes("'/namespace'")));
    assert.deepStrictEqual(result.units, []);
  });

  it("does not implicitly re-export a namespace alias as a value", () => {
    const root = path.resolve("module-namespace-implicit-export");
    const middleFile = path.join(root, "middle.rsgl");
    const libraryFile = path.join(root, "library.rsgl");
    const files = [
      sourceFile(middleFile, "import * as common from \"./library.rsgl\""),
      sourceFile(libraryFile, "let VALUE = 1")
    ];
    const program = bindRsglProgram(files);
    const environments = createProgramCompileEnvironments(
      program,
      resolveRsglCompileConfiguration({})
    );
    const middle = environments.get(path.normalize(middleFile));

    assert.ok(middle);
    assert.ok(isModuleNamespaceValue(middle.importedValues.get("common")));
    assert.strictEqual(middle.exportedValues.has("common"), false);
  });

  it("lets collection and spread guards reject namespace values as non-plain objects", () => {
    const namespaceValue = new ModuleNamespaceValue({
      fileName: "/virtual/library.rsgl",
      namespace: "minecraft",
      values: new Map(),
      valueOrigins: new Map(),
      valuePathOrigins: new Map(),
      valueIssues: new Map(),
      templates: new Map()
    });
    for (const [source, expectedCode] of [
      ["[...common]", "rsgl.invalidListSpread"],
      ["{ ...common }", "rsgl.invalidObjectSpread"],
      ["keys(common)", "rsgl.collectionExpected"]
    ] as const) {
      const errors: string[] = [];
      const context: EvaluationContext = {
        namespace: "minecraft",
        variables: new Map([["common", namespaceValue]]),
        onError: code => errors.push(code)
      };

      assert.strictEqual(evaluateExpression(parseExpression(source), context), undefined, source);
      assert.deepStrictEqual(errors, [expectedCode], source);
    }
  });
});

function sourceFile(fileName: string, source: string): RsglSourceFile {
  return { fileName, module: parseRsgl(source) };
}

function parseExpression(source: string) {
  const statement = parseRsgl(`let result = ${source}`).statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected expression '${source}'.`);
  }
  return statement.value;
}
