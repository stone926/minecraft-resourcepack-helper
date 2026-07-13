import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglProgram,
  type RsglProgram,
  type RsglSourceFile
} from "../../src/semantic";

describe("RSGL imported Function argument validation", () => {
  it("fully resolves named-import identifier arguments and undefined symbols", () => {
    const root = path.resolve("C:/rsgl-tests/imported-function/named");
    const libraryFile = path.join(root, "library.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const mainSource = [
      "import { f } from \"./library.rsgl\"",
      "let n = 1",
      "let wrong = f(n)",
      "let absent = f(missing)"
    ].join("\n");
    const program = bind([
      source(libraryFile, [
        "let f: (String) -> String = value => value",
        "export { f }"
      ]),
      source(mainFile, mainSource)
    ]);
    const diagnostics = diagnosticsFor(program, mainFile);

    assert.deepStrictEqual(diagnostics.map(item => item.code), [
      "rsgl.lambdaArgumentTypeMismatch",
      "rsgl.undefinedSymbol"
    ]);
    assert.deepStrictEqual(
      diagnostics.map(item => mainSource.slice(item.range.start, item.range.end)),
      ["n", "missing"]
    );
  });

  it("uses the lexical snapshot for a local passed through a re-export", () => {
    const root = path.resolve("C:/rsgl-tests/imported-function/reexport");
    const libraryFile = path.join(root, "library.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const mainSource = [
      "import { routed } from \"./barrel.rsgl\"",
      "if true {",
      "  let local = 1",
      "  let wrong = routed(local)",
      "}"
    ].join("\n");
    const program = bind([
      source(libraryFile, [
        "let f: (String) -> String = value => value",
        "export { f }"
      ]),
      source(barrelFile, "export { f as routed } from \"./library.rsgl\""),
      source(mainFile, mainSource)
    ]);
    const diagnostics = diagnosticsFor(program, mainFile);

    assert.deepStrictEqual(diagnostics.map(item => item.code), ["rsgl.lambdaArgumentTypeMismatch"]);
    assert.strictEqual(mainSource.slice(diagnostics[0].range.start, diagnostics[0].range.end), "local");
  });

  it("checks member, call, list, and object arguments without outer cascades", () => {
    const root = path.resolve("C:/rsgl-tests/imported-function/expressions");
    const libraryFile = path.join(root, "library.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const mainSource = [
      "import { acceptString, acceptNames, acceptEntry } from \"./library.rsgl\"",
      "let makeNumber: (Number) -> Number = value => value",
      "let box = { value: 1 }",
      "let member = acceptString(box.value)",
      "let call = acceptString(makeNumber(1))",
      "let list = acceptNames([\"ok\", 2])",
      "let object = acceptEntry({ name: missingName })"
    ].join("\n");
    const program = bind([
      source(libraryFile, [
        "type Entry = { name: String }",
        "let acceptString: (String) -> String = value => value",
        "let acceptNames: (List<String>) -> String = values => \"ok\"",
        "let acceptEntry: (Entry) -> String = entry => entry.name",
        "export { acceptString, acceptNames, acceptEntry }"
      ]),
      source(mainFile, mainSource)
    ]);
    const diagnostics = diagnosticsFor(program, mainFile);

    assert.deepStrictEqual(diagnostics.map(item => item.code), [
      "rsgl.lambdaArgumentTypeMismatch",
      "rsgl.lambdaArgumentTypeMismatch",
      "rsgl.typeMismatch",
      "rsgl.undefinedSymbol"
    ]);
    assert.deepStrictEqual(
      diagnostics.map(item => mainSource.slice(item.range.start, item.range.end)),
      ["box.value", "makeNumber(1)", "2", "missingName"]
    );
    assert.strictEqual(
      diagnostics.filter(item => item.code === "rsgl.lambdaArgumentTypeMismatch").length,
      2,
      "nested list/object diagnostics must suppress a redundant outer mismatch"
    );
  });

  it("does not duplicate a bare-import argument diagnostic from the first bind pass", () => {
    const root = path.resolve("C:/rsgl-tests/imported-function/bare");
    const libraryFile = path.join(root, "library.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const mainSource = [
      "import \"./library.rsgl\"",
      "let absent = f(missing)"
    ].join("\n");
    const program = bind([
      source(libraryFile, [
        "let f: (String) -> String = value => value",
        "export { f }"
      ]),
      source(mainFile, mainSource)
    ]);
    const diagnostics = diagnosticsFor(program, mainFile);

    assert.deepStrictEqual(diagnostics.map(item => item.code), ["rsgl.undefinedSymbol"]);
    assert.strictEqual(mainSource.slice(diagnostics[0].range.start, diagnostics[0].range.end), "missing");
  });
});

function bind(files: RsglSourceFile[]): RsglProgram {
  return bindRsglProgram(files, { stdlibRoot: path.resolve("does-not-exist") });
}

function source(fileName: string, lines: string | string[]): RsglSourceFile {
  return {
    fileName,
    module: parseRsgl(Array.isArray(lines) ? lines.join("\n") : lines)
  };
}

function diagnosticsFor(program: RsglProgram, fileName: string) {
  return program.fileDiagnostics.filter(item =>
    path.normalize(item.fileName) === path.normalize(fileName)
  );
}
