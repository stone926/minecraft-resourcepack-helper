import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglProgram,
  type RsglProgram,
  type RsglSourceFile
} from "../../src/semantic";

describe("RSGL program type aliases", () => {
  it("binds a pure type import before its first contextual annotation check", () => {
    const root = path.resolve("C:/rsgl-tests/类型环境");
    const typesFile = path.join(root, "共享类型.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const program = bind([
      source(typesFile, [
        "type Crop = { name: String; top?: TextureId }",
        "export { Crop }"
      ]),
      source(mainFile, [
        "import { Crop as ImportedCrop } from \"./共享类型.rsgl\"",
        "let valid: ImportedCrop = { name: \"wheat\" }",
        "let invalid: ImportedCrop = { nmae: \"carrot\" }"
      ])
    ]);

    assert.deepStrictEqual(codesFor(program, mainFile), [
      "rsgl.excessRecordField",
      "rsgl.missingRecordField"
    ]);
    const main = model(program, mainFile);
    assert.strictEqual(main.scope.symbols.has("ImportedCrop"), false, "pure type imports must not leave fake values");
    assert.strictEqual(main.scope.typeAliases.get("ImportedCrop")?.type?.kind, "Object");
    assert.strictEqual(
      main.scope.typeAliases.get("ImportedCrop")?.node,
      model(program, typesFile).scope.typeAliases.get("Crop")?.node
    );
  });

  it("allows one specifier to bind independent value and type namespaces", () => {
    const root = path.resolve("C:/rsgl-tests/both-namespaces");
    const sharedFile = path.join(root, "shared.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const program = bind([
      source(sharedFile, [
        "type Shared = { label: String }",
        "let Shared = 7",
        "export { Shared }"
      ]),
      source(mainFile, [
        "import { Shared } from \"./shared.rsgl\"",
        "let typed: Shared = { label: \"ok\" }",
        "let value: Number = Shared"
      ])
    ]);

    assert.deepStrictEqual(codesFor(program, mainFile), []);
    const main = model(program, mainFile);
    assert.strictEqual(main.scope.symbols.get("Shared")?.type.kind, "Number");
    assert.strictEqual(main.scope.typeAliases.get("Shared")?.type?.kind, "Object");
  });

  it("does not import type aliases through a module namespace binding", () => {
    const root = path.resolve("C:/rsgl-tests/module-namespace-types");
    const sharedFile = path.join(root, "shared.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const program = bind([
      source(sharedFile, [
        "type Hidden = { label: String }",
        "let VALUE = 1",
        "export { Hidden, VALUE }"
      ]),
      source(mainFile, [
        "import * as common from \"./shared.rsgl\"",
        "let unresolved: Hidden = { label: \"not imported\" }",
        "let value = common.VALUE"
      ])
    ]);
    const main = model(program, mainFile);

    assert.strictEqual(main.scope.typeAliases.has("Hidden"), false);
    assert.strictEqual(main.scope.symbols.get("unresolved")?.type.kind, "Unknown");
    assert.strictEqual(main.scope.symbols.get("value")?.type.kind, "Number");
  });

  it("preserves aliases through a non-ASCII re-export chain and implicit exports", () => {
    const root = path.resolve("C:/rsgl-tests/资源 包/reexports");
    const sourceFile = path.join(root, "原始.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const localBarrelFile = path.join(root, "local-barrel.rsgl");
    const implicitFile = path.join(root, "implicit.rsgl");
    const mainFile = path.join(root, "入口.rsgl");
    const program = bind([
      source(sourceFile, [
        "type Original = { id: String }",
        "export { Original as Public }"
      ]),
      source(barrelFile, "export { Public as Forwarded } from \"./原始.rsgl\""),
      source(localBarrelFile, [
        "import { Forwarded } from \"./barrel.rsgl\"",
        "export { Forwarded as LocalForward }"
      ]),
      source(implicitFile, "type Implicit = { enabled: Boolean }"),
      source(mainFile, [
        "import { LocalForward } from \"./local-barrel.rsgl\"",
        "import { Implicit } from \"./implicit.rsgl\"",
        "let first: LocalForward = { id: \"ok\" }",
        "let second: Implicit = { enabled: true }"
      ])
    ]);

    assert.deepStrictEqual(program.fileDiagnostics, []);
    const forwarded = model(program, mainFile).scope.typeAliases.get("LocalForward");
    assert.strictEqual(forwarded?.node, model(program, sourceFile).scope.typeAliases.get("Original")?.node);
    assert.strictEqual(model(program, localBarrelFile).scope.symbols.has("Forwarded"), false);
    assert.strictEqual(model(program, mainFile).scope.symbols.has("LocalForward"), false);
    assert.ok(program.typeAliasExportMaps?.get(path.normalize(implicitFile))?.has("Implicit"));
  });

  it("reports type-alias re-export and cross-module alias cycles deterministically", () => {
    const root = path.resolve("C:/rsgl-tests/type-cycles");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const program = bind([
      source(aFile, [
        "import { B } from \"./b.rsgl\"",
        "type A = { next: B }",
        "export { A }",
        "export * from \"./b.rsgl\""
      ]),
      source(bFile, [
        "import { A } from \"./a.rsgl\"",
        "type B = { next: A }",
        "export { B }",
        "export * from \"./a.rsgl\""
      ])
    ]);

    const codes = program.fileDiagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.circularTypeAlias"));
    assert.strictEqual(codes.filter(code => code === "rsgl.circularTypeAliasReExport").length, 2);
  });

  it("does not duplicate a local alias cycle in program binding", () => {
    const fileName = path.resolve("C:/rsgl-tests/local-cycle/main.rsgl");
    const program = bind([source(fileName, "type Recursive = { next: Recursive }")]);

    assert.strictEqual(
      program.fileDiagnostics.filter(diagnostic => diagnostic.code === "rsgl.circularTypeAlias").length,
      1
    );
  });

  it("does not label a pure value re-export cycle as a type-alias cycle", () => {
    const root = path.resolve("C:/rsgl-tests/value-reexport-cycle");
    const program = bind([
      source(path.join(root, "a.rsgl"), "export * from \"./b.rsgl\""),
      source(path.join(root, "b.rsgl"), "export * from \"./a.rsgl\"")
    ]);

    assert.strictEqual(
      program.fileDiagnostics.some(diagnostic => diagnostic.code === "rsgl.circularTypeAliasReExport"),
      false
    );
    assert.strictEqual(
      program.fileDiagnostics.filter(diagnostic => diagnostic.code === "rsgl.importCycle").length,
      2
    );
  });
});

function bind(files: RsglSourceFile[]): RsglProgram {
  return bindRsglProgram(files, { stdlibRoot: path.resolve("does-not-exist") });
}

function source(fileName: string, lines: string | string[]): RsglSourceFile {
  return { fileName, module: parseRsgl(Array.isArray(lines) ? lines.join("\n") : lines) };
}

function model(program: RsglProgram, fileName: string) {
  const result = program.models.find(candidate => path.normalize(candidate.fileName) === path.normalize(fileName));
  assert.ok(result, `Expected semantic model for ${fileName}`);
  return result;
}

function codesFor(program: RsglProgram, fileName: string): string[] {
  return program.fileDiagnostics
    .filter(diagnostic => path.normalize(diagnostic.fileName) === path.normalize(fileName))
    .map(diagnostic => diagnostic.code);
}
