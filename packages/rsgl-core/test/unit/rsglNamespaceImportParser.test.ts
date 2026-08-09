import * as assert from "node:assert/strict";
import { parseRsgl } from "../../src/parser";

describe("RSGL namespace import parser", () => {
  it("keeps namespace, bare import-all, named, and unsupported default imports distinct", () => {
    const module = parseRsgl([
      "import * as common from \"./common.rsgl\"",
      "import \"./bare.rsgl\"",
      "import { stone as rock } from \"./named.rsgl\"",
      "import fallback from \"./default.rsgl\""
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unsupportedDefaultImport"
    ]);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "ImportDecl",
      "ImportDecl",
      "ImportDecl",
      "ImportDecl"
    ]);
    const [namespaceImport, bareImport, namedImport, defaultImport] = module.statements;
    assert.strictEqual(namespaceImport.kind, "ImportDecl");
    assert.strictEqual(bareImport.kind, "ImportDecl");
    assert.strictEqual(namedImport.kind, "ImportDecl");
    assert.strictEqual(defaultImport.kind, "ImportDecl");
    if (
      namespaceImport.kind !== "ImportDecl"
      || bareImport.kind !== "ImportDecl"
      || namedImport.kind !== "ImportDecl"
      || defaultImport.kind !== "ImportDecl"
    ) {
      return;
    }

    assert.strictEqual(namespaceImport.namespaceName?.text, "common");
    assert.strictEqual(namespaceImport.defaultName, undefined);
    assert.deepStrictEqual(namespaceImport.namedImports, []);
    assert.strictEqual(namespaceImport.source?.value, "./common.rsgl");

    assert.strictEqual(bareImport.namespaceName, undefined);
    assert.strictEqual(bareImport.defaultName, undefined);
    assert.deepStrictEqual(bareImport.namedImports, []);

    assert.strictEqual(namedImport.namespaceName, undefined);
    assert.strictEqual(namedImport.defaultName, undefined);
    assert.deepStrictEqual(namedImport.namedImports.map(specifier => [
      specifier.imported.text,
      specifier.local.text
    ]), [["stone", "rock"]]);

    assert.strictEqual(defaultImport.namespaceName, undefined);
    assert.strictEqual(defaultImport.defaultName?.text, "fallback");
    assert.deepStrictEqual(defaultImport.namedImports, []);
  });

  it("recovers missing namespace import clauses without swallowing the next statement", () => {
    const cases = [
      {
        source: "import * common from \"./common.rsgl\"\nlet after = 1",
        code: "rsgl.expectedNamespaceImportAs",
        alias: "common",
        sourceValue: "./common.rsgl"
      },
      {
        source: "import * as from \"./common.rsgl\"\nlet after = 1",
        code: "rsgl.expectedNamespaceImportAlias",
        alias: undefined,
        sourceValue: "./common.rsgl"
      },
      {
        source: "import * as common \"./common.rsgl\"\nlet after = 1",
        code: "rsgl.expectedNamespaceImportFrom",
        alias: "common",
        sourceValue: "./common.rsgl"
      },
      {
        source: "import * as common from\nlet after = 1",
        code: "rsgl.expectedImportSource",
        alias: "common",
        sourceValue: undefined
      }
    ] as const;

    for (const testCase of cases) {
      const module = parseRsgl(testCase.source);
      const namespaceImport = module.statements[0];

      assert.deepStrictEqual(
        module.diagnostics.map(diagnostic => diagnostic.code),
        [testCase.code],
        testCase.source
      );
      assert.deepStrictEqual(
        module.statements.map(statement => statement.kind),
        ["ImportDecl", "LetDecl"],
        testCase.source
      );
      assert.strictEqual(namespaceImport.kind, "ImportDecl");
      if (namespaceImport.kind === "ImportDecl") {
        assert.strictEqual(namespaceImport.namespaceName?.text, testCase.alias);
        assert.strictEqual(namespaceImport.source?.value, testCase.sourceValue);
      }
    }
  });
});
