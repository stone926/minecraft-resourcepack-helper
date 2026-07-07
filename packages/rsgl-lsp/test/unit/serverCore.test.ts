import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CompletionItemKind, DiagnosticSeverity } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  RsglWorkspaceSemanticCache,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  type RsglSemanticToken,
  type RsglSymbol
} from "../../../rsgl-core/src";
import {
  clampOffset,
  completionItemsForContent,
  computeDocumentDiagnostics,
  computeDocumentSemanticTokens,
  encodeSemanticTokens,
  toLspDiagnostic,
  toLspSeverity,
  toValidationSettings,
  type RsglValidationSettings
} from "../../src/serverCore";

const emptySettings: RsglValidationSettings = { defaultAssetsPath: null, resourcePackRoots: [] };

function documentOf(text: string): TextDocument {
  return TextDocument.create("file:///virtual/test.rsgl", "rsgl", 1, text);
}

function templateSymbol(name: string): RsglSymbol {
  return {
    name,
    kind: "template",
    type: { kind: "Function" },
    signature: { parameters: [], returnType: { kind: "Unknown" } }
  };
}

describe("RSGL LSP server core", () => {
  it("maps every RSGL severity onto the LSP severity scale", () => {
    assert.strictEqual(toLspSeverity("error"), DiagnosticSeverity.Error);
    assert.strictEqual(toLspSeverity("warning"), DiagnosticSeverity.Warning);
    assert.strictEqual(toLspSeverity("info"), DiagnosticSeverity.Information);
  });

  it("clamps offsets to the document text range", () => {
    const document = documentOf("model");
    assert.strictEqual(clampOffset(document, -3), 0);
    assert.strictEqual(clampOffset(document, 2), 2);
    assert.strictEqual(clampOffset(document, 99), 5);
  });

  it("converts diagnostics with out-of-range offsets to positions at the document edges", () => {
    const document = documentOf("model");
    const diagnostic = toLspDiagnostic(document, {
      code: "rsgl.test",
      message: "boom",
      severity: "error",
      range: { start: -5, end: 999 }
    });

    assert.deepStrictEqual(diagnostic.range, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    });
    assert.strictEqual(diagnostic.severity, DiagnosticSeverity.Error);
    assert.strictEqual(diagnostic.code, "rsgl.test");
    assert.strictEqual(diagnostic.source, "RSGL");
    assert.strictEqual(diagnostic.message, "boom");
  });

  it("widens zero-length diagnostic ranges by one character", () => {
    const document = documentOf("model x");
    const diagnostic = toLspDiagnostic(document, {
      code: "rsgl.test",
      message: "empty range",
      severity: "warning",
      range: { start: 2, end: 2 }
    });

    assert.deepStrictEqual(diagnostic.range, {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 3 }
    });
  });

  it("accepts well-formed settings payloads", () => {
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: "E:/assets", resourcePackRoots: ["a", "b"] }),
      { defaultAssetsPath: "E:/assets", resourcePackRoots: ["a", "b"] }
    );
  });

  it("falls back to safe defaults for garbage settings payloads", () => {
    const fallback = { defaultAssetsPath: null, resourcePackRoots: [] };
    assert.deepStrictEqual(toValidationSettings(undefined), fallback);
    assert.deepStrictEqual(toValidationSettings(null), fallback);
    assert.deepStrictEqual(toValidationSettings(42), fallback);
    assert.deepStrictEqual(toValidationSettings("nope"), fallback);
    assert.deepStrictEqual(toValidationSettings({}), fallback);
  });

  it("drops blank asset paths and non-string resource pack roots", () => {
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: "   ", resourcePackRoots: ["kept", 5, null, {}] }),
      { defaultAssetsPath: null, resourcePackRoots: ["kept"] }
    );
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: 7, resourcePackRoots: "not-an-array" }),
      { defaultAssetsPath: null, resourcePackRoots: [] }
    );
  });

  it("filters program diagnostics to the requested file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-"));
    try {
      const entryFile = path.join(root, "entry.rsgl");
      const brokenFile = path.join(root, "broken.rsgl");
      const entryText = [
        "import { cube } from \"./broken.rsgl\"",
        "use cube(stone, texture: minecraft:block/stone)"
      ].join("\n");
      const brokenText = [
        "template cube(id: ResourceId, texture: TextureId = id) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}",
        "use missingTemplate()"
      ].join("\n");
      fs.writeFileSync(entryFile, entryText);
      fs.writeFileSync(brokenFile, brokenText);

      const cache = RsglWorkspaceSemanticCache.create();
      const deps = {
        loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName),
        settings: emptySettings
      };

      const entryDiagnostics = computeDocumentDiagnostics(documentOf(entryText), entryFile, deps);
      assert.deepStrictEqual(entryDiagnostics.map(diagnostic => diagnostic.code), []);

      const brokenDiagnostics = computeDocumentDiagnostics(documentOf(brokenText), brokenFile, deps);
      assert.ok(brokenDiagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to single-module compilation when the entry cannot be loaded", () => {
    const missingFile = path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-missing", "untracked.rsgl");
    const text = "use missingTemplate()";
    const cache = RsglWorkspaceSemanticCache.create();
    const diagnostics = computeDocumentDiagnostics(documentOf(text), missingFile, {
      loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
      settings: emptySettings
    });

    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"));
    assert.ok(diagnostics.every(diagnostic => diagnostic.source === "RSGL"));
  });

  it("maps completion candidates and workspace symbols to completion items", () => {
    const items = completionItemsForContent("", 0, [
      templateSymbol("myCube"),
      { name: "tex", kind: "variable", type: { kind: "TextureId" } }
    ]);

    const target = items.find(item => item.label === "target");
    assert.strictEqual(target?.kind, CompletionItemKind.Snippet);
    assert.strictEqual(typeof target?.insertText, "string");
    assert.strictEqual(typeof target?.detail, "string");

    const seq = items.find(item => item.label === "seq");
    assert.strictEqual(seq?.kind, CompletionItemKind.Function);

    const myCube = items.find(item => item.label === "myCube");
    assert.deepStrictEqual(myCube, {
      label: "myCube",
      kind: CompletionItemKind.Function,
      detail: "template: function"
    });

    const tex = items.find(item => item.label === "tex");
    assert.deepStrictEqual(tex, {
      label: "tex",
      kind: CompletionItemKind.Variable,
      detail: "variable: TextureId"
    });
  });

  it("prefers syntactic candidates over workspace symbols with the same label", () => {
    const items = completionItemsForContent("", 0, [templateSymbol("target")]);
    const matches = items.filter(item => item.label === "target");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].kind, CompletionItemKind.Snippet);
  });

  it("encodes semantic tokens relative to the previous token across lines", () => {
    const document = documentOf("let aa = bb\nuse aa bb");
    const token = (start: number): RsglSemanticToken =>
      ({ start, length: 2, tokenType: 3, tokenModifiers: 1 });

    const data = encodeSemanticTokens([token(4), token(9), token(16), token(19)], document);

    assert.deepStrictEqual(data, [
      0, 4, 2, 3, 1,
      0, 5, 2, 3, 1,
      1, 4, 2, 3, 1,
      0, 3, 2, 3, 1
    ]);
  });

  it("encodes an empty token list as an empty data array", () => {
    assert.deepStrictEqual(encodeSemanticTokens([], documentOf("let a = 1")), []);
  });

  it("computes encoded semantic tokens for a document via the single-module fallback", () => {
    const missingFile = path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-missing", "untracked.rsgl");
    const text = "template cube() {}\nuse cube()";
    const cache = RsglWorkspaceSemanticCache.create();

    const data = computeDocumentSemanticTokens(documentOf(text), missingFile, {
      loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName)
    });

    const functionType = rsglSemanticTokenTypes.indexOf("function");
    const declaration = 1 << rsglSemanticTokenModifiers.indexOf("declaration");
    assert.deepStrictEqual(data, [
      0, 9, 4, functionType, declaration,
      1, 4, 4, functionType, 0
    ]);
  });
});
