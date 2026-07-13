import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRsglCompletionItems } from "../../src/completionService";
import {
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  semanticModelForRsglDocument
} from "../../src/languageService";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";

const fallbackWorkspace = {
  loadProgramFromEntry(): never {
    throw new Error("Use the open document fallback.");
  }
};

describe("RSGL member language service", () => {
  it("uses the touched lexical receiver and exposes only safe union fields", () => {
    const text = [
      "type Entry = { name: String; top?: TextureId; nested: { title: String } }",
      "type Left = { common: String; leftOnly: Number; maybe?: TextureId }",
      "type Right = { common: String; rightOnly: Boolean; maybe?: TextureId }",
      "let unrelated: (String) -> String = (hidden) => hidden",
      "let titleOf: (Entry) -> String = (e) => e.nested.title",
      "let nameOf: (Entry) -> String = (entry) => entry.name",
      "let choose: (Left | Right) -> String = (e) => e.common"
    ].join("\n");
    const fileName = path.resolve("member-scope.rsgl");
    const document = { fileName, getText: () => text };

    const entryMemberOffset = text.indexOf("entry.name") + "entry.".length;
    const entryItems = getRsglDocumentCompletionItems(document, entryMemberOffset, fallbackWorkspace);
    assert.deepStrictEqual(entryItems, [
      { label: "name", kind: "property", detail: "property: String" },
      { label: "top", kind: "property", detail: "optional property: TextureId" },
      { label: "nested", kind: "property", detail: "property: { title: String }" }
    ]);
    assert.strictEqual(entryItems.some(item => item.label === "hidden" || item.label === "e"), false);

    const nestedOffset = text.indexOf("nested.title") + "nested.".length;
    assert.deepStrictEqual(
      getRsglDocumentCompletionItems(document, nestedOffset, fallbackWorkspace),
      [{ label: "title", kind: "property", detail: "property: String" }]
    );

    const unionOffset = text.lastIndexOf("e.common") + "e.".length;
    assert.deepStrictEqual(
      getRsglDocumentCompletionItems(document, unionOffset, fallbackWorkspace),
      [
        { label: "common", kind: "property", detail: "property: String" },
        { label: "maybe", kind: "property", detail: "optional property: TextureId" }
      ]
    );

    const incompleteText = [
      "type Entry = { name: String; top?: TextureId }",
      "let unrelated: (String) -> String = (hidden) => hidden",
      "let pick: (Entry) -> String = (e) => e."
    ].join("\n");
    const incompleteDocument = {
      fileName: path.resolve("member-incomplete.rsgl"),
      getText: () => incompleteText
    };
    const incompleteItems = getRsglDocumentCompletionItems(
      incompleteDocument,
      incompleteText.length,
      fallbackWorkspace
    );
    assert.deepStrictEqual(incompleteItems, [
      { label: "name", kind: "property", detail: "property: String" },
      { label: "top", kind: "property", detail: "optional property: TextureId" }
    ]);
    assert.strictEqual(incompleteItems.some(item => item.label === "hidden"), false);
  });

  it("hovers annotated fields and resolves local declaration ranges", () => {
    const text = [
      "type Entry = { name: String; top?: TextureId }",
      "let nameOf: (Entry) -> String = (entry) => entry.name",
      "let topOf: (Entry) -> TextureId = (entry) => entry.top"
    ].join("\n");
    const fileName = path.resolve("member-hover.rsgl");
    const document = { fileName, getText: () => text };
    const nameUse = text.indexOf("entry.name") + "entry.".length;
    const topUse = text.lastIndexOf("entry.top") + "entry.".length;

    assert.deepStrictEqual(getRsglDocumentHoverInfo(document, nameUse + 1, fallbackWorkspace), {
      range: { start: nameUse, end: nameUse + "name".length },
      label: "property name: String"
    });
    assert.deepStrictEqual(getRsglDocumentHoverInfo(document, topUse + 1, fallbackWorkspace), {
      range: { start: topUse, end: topUse + "top".length },
      label: "property top?: TextureId"
    });

    const declarationStart = text.indexOf("name");
    assert.deepStrictEqual(
      getRsglDocumentDefinitionLocation(document, nameUse + 1, fallbackWorkspace),
      {
        fileName,
        range: { start: declarationStart, end: declarationStart + "name".length }
      }
    );
  });

  it("resolves imported record fields through aliases and re-exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-member-类型 工具-"));
    try {
      const sourceFile = path.join(root, "原始字段.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const mainFile = path.join(root, "入口.rsgl");
      const sourceText = [
        "type Original = { name: String; top?: TextureId }",
        "export { Original as Public }"
      ].join("\n");
      const barrelText = "export { Public as Forwarded } from \"./原始字段.rsgl\"";
      const mainText = [
        "import { Forwarded as Local } from \"./barrel.rsgl\"",
        "let entry: Local = { name: \"wheat\" }",
        "let title = entry.name"
      ].join("\n");
      fs.writeFileSync(sourceFile, sourceText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(mainFile, mainText);

      const workspace = RsglWorkspaceSemanticCache.create();
      const document = { fileName: mainFile, getText: () => mainText };
      const memberStart = mainText.lastIndexOf("name");
      const completionOffset = mainText.lastIndexOf("entry.name") + "entry.".length;
      assert.deepStrictEqual(getRsglDocumentCompletionItems(document, completionOffset, workspace), [
        { label: "name", kind: "property", detail: "property: String" },
        { label: "top", kind: "property", detail: "optional property: TextureId" }
      ]);
      assert.deepStrictEqual(getRsglDocumentHoverInfo(document, memberStart + 1, workspace), {
        range: { start: memberStart, end: memberStart + "name".length },
        label: "property name: String"
      });
      const originalField = sourceText.indexOf("name");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, memberStart + 1, workspace),
        {
          fileName: sourceFile,
          range: { start: originalField, end: originalField + "name".length }
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects value or type namespace by context and preserves ambiguous collisions", () => {
    const text = [
      "type Entry = { name: String }",
      "let Entry = 42",
      "let value: Entry = { name: \"wheat\" }",
      "let copy = Entry"
    ].join("\n");
    const document = { fileName: path.resolve("completion-namespaces.rsgl"), getText: () => text };
    const annotationOffset = text.indexOf("Entry = { name", text.indexOf("let value")) + 2;
    const valueOffset = text.lastIndexOf("Entry") + 2;

    assert.deepStrictEqual(
      getRsglDocumentCompletionItems(document, annotationOffset, fallbackWorkspace)
        .filter(item => item.label === "Entry"),
      [{ label: "Entry", kind: "struct", detail: "type alias: { name: String }" }]
    );
    assert.deepStrictEqual(
      getRsglDocumentCompletionItems(document, valueOffset, fallbackWorkspace)
        .filter(item => item.label === "Entry"),
      [{ label: "Entry", kind: "variable", detail: "variable: 42" }]
    );

    const model = semanticModelForRsglDocument(document, fallbackWorkspace);
    assert.deepStrictEqual(
      getRsglCompletionItems("", 0, model.symbols, model.scope.typeAliases, "both")
        .filter(item => item.label === "Entry"),
      [
        { label: "Entry", kind: "variable", detail: "variable: 42" },
        { label: "Entry", kind: "struct", detail: "type alias: { name: String }" }
      ]
    );
  });
});
