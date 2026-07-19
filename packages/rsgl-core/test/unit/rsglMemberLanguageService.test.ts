import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRsglCompletionItems } from "../../src/completionService";
import {
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  getRsglDocumentReferenceLocations,
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

  it("finds structural field references from uses and declarations across union branches", () => {
    const text = [
      "type Left = { common: String; leftOnly: Number }",
      "type Right = { common: String; rightOnly: Boolean }",
      "let leftValue: Left = { common: \"left\", leftOnly: 1 }",
      "let rightValue: Right = { common: \"right\", rightOnly: true }",
      "let fromLeft: (Left) -> String = (left) => left.common",
      "let fromRight: (Right) -> String = (right) => right.common",
      "let fromEither: (Left | Right) -> String = (either) => either.common"
    ].join("\n");
    const fileName = path.resolve("member-references.rsgl");
    const document = { fileName, getText: () => text };
    const leftDeclaration = text.indexOf("common");
    const rightDeclaration = text.indexOf("common", leftDeclaration + "common".length);
    const leftObjectKey = text.indexOf("common", rightDeclaration + "common".length);
    const rightObjectKey = text.indexOf("common", leftObjectKey + "common".length);
    const leftUse = text.indexOf("left.common") + "left.".length;
    const rightUse = text.indexOf("right.common") + "right.".length;
    const unionUse = text.indexOf("either.common") + "either.".length;

    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, unionUse + 1, true, fallbackWorkspace)
        .map(location => location.range.start),
      [leftDeclaration, rightDeclaration, leftObjectKey, rightObjectKey, leftUse, rightUse, unionUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, unionUse + 1, false, fallbackWorkspace)
        .map(location => location.range.start),
      [leftObjectKey, rightObjectKey, leftUse, rightUse, unionUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, leftDeclaration + 1, true, fallbackWorkspace)
        .map(location => location.range.start),
      [leftDeclaration, leftObjectKey, leftUse, unionUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, rightUse + 1, true, fallbackWorkspace)
        .map(location => location.range.start),
      [rightDeclaration, rightObjectKey, rightUse, unionUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, leftObjectKey + 1, true, fallbackWorkspace)
        .map(location => location.range.start),
      [leftDeclaration, leftObjectKey, leftUse, unionUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentDefinitionLocation(document, leftObjectKey + 1, fallbackWorkspace),
      {
        fileName,
        range: { start: leftDeclaration, end: leftDeclaration + "common".length }
      }
    );
    assert.deepStrictEqual(
      getRsglDocumentDefinitionLocation(document, leftDeclaration + 1, fallbackWorkspace),
      {
        fileName,
        range: { start: leftDeclaration, end: leftDeclaration + "common".length }
      }
    );
  });

  it("keeps fallback field identities isolated by declaration owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-member-owner-identity-"));
    try {
      const alphaFile = path.join(root, "alpha.rsgl");
      const bravoFile = path.join(root, "bravo.rsgl");
      const mainFile = path.join(root, "main.rsgl");
      const alphaText = [
        "type Alpha = { common: String }",
        "export { Alpha }"
      ].join("\n");
      const bravoText = [
        "type Bravo = { common: String }",
        "export { Bravo }"
      ].join("\n");
      const mainText = [
        "import { Alpha } from \"./alpha.rsgl\"",
        "import { Bravo } from \"./bravo.rsgl\"",
        "let choose: (Boolean, Alpha, Alpha) -> String = (flag, first, second) => (flag ? first : second).common",
        "let other: (Bravo) -> String = (value) => value.common"
      ].join("\n");
      fs.writeFileSync(alphaFile, alphaText);
      fs.writeFileSync(bravoFile, bravoText);
      fs.writeFileSync(mainFile, mainText);

      const cache = RsglWorkspaceSemanticCache.create();
      const workspace = {
        loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName),
        loadProgramForNavigation: () => cache.loadProgramFromDirectory(root)
      };
      const document = { fileName: mainFile, getText: () => mainText };
      const alphaUse = mainText.indexOf(".common") + 1;
      const bravoUse = mainText.lastIndexOf(".common") + 1;
      const references = getRsglDocumentReferenceLocations(
        document,
        alphaUse + 1,
        true,
        workspace
      );

      assert.deepStrictEqual(
        references.filter(location => location.fileName === alphaFile)
          .map(location => location.range.start),
        [alphaText.indexOf("common")]
      );
      assert.strictEqual(
        references.some(location => location.fileName === bravoFile),
        false
      );
      assert.deepStrictEqual(
        references.filter(location => location.fileName === mainFile)
          .map(location => location.range.start),
        [alphaUse]
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(document, bravoUse + 1, true, workspace)
          .filter(location => location.fileName === mainFile)
          .map(location => location.range.start),
        [bravoUse]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves imported record fields through aliases and re-exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-member-类型 工具-"));
    try {
      const sourceFile = path.join(root, "原始字段.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const mainFile = path.join(root, "入口.rsgl");
      const sourceText = [
        "type Original = { name: String; top?: TextureId }",
        "export { Original as Public }",
        "let marker = 1",
        "export { marker }"
      ].join("\n");
      const barrelText = "export { Public as Forwarded } from \"./原始字段.rsgl\"";
      const mainText = [
        "import { Forwarded as Local } from \"./barrel.rsgl\"",
        "import * as original from \"./原始字段.rsgl\"",
        "let entry: Local = { name: \"wheat\" }",
        "let title = entry.name",
        "let copy = entry.name",
        "let firstMarker = original.marker",
        "let secondMarker = original.marker"
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
      const firstMember = mainText.indexOf("entry.name") + "entry.".length;
      const secondMember = mainText.lastIndexOf("entry.name") + "entry.".length;
      const objectKey = mainText.indexOf("name", mainText.indexOf("{ name:"));
      const references = getRsglDocumentReferenceLocations(
        document,
        secondMember + 1,
        true,
        workspace
      );
      assert.deepStrictEqual(
        references.filter(location => location.fileName === sourceFile)
          .map(location => location.range.start),
        [originalField]
      );
      assert.deepStrictEqual(
        references.filter(location => location.fileName === mainFile)
          .map(location => location.range.start),
        [objectKey, firstMember, secondMember]
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(document, secondMember + 1, false, workspace)
          .map(location => location.range.start),
        [objectKey, firstMember, secondMember]
      );

      const firstNamespaceMember = mainText.indexOf("original.marker") + "original.".length;
      const secondNamespaceMember = mainText.lastIndexOf("original.marker") + "original.".length;
      const namespaceReferences = getRsglDocumentReferenceLocations(
        document,
        secondNamespaceMember + 1,
        false,
        workspace
      );
      assert.deepStrictEqual(
        namespaceReferences.filter(location => location.fileName === mainFile)
          .map(location => location.range.start),
        [firstNamespaceMember, secondNamespaceMember]
      );
      assert.strictEqual(
        new Set(namespaceReferences.map(location =>
          `${location.fileName}:${location.range.start}:${location.range.end}`
        )).size,
        namespaceReferences.length
      );

      const namespaceAliasDeclaration = mainText.indexOf("original", mainText.indexOf("import *"));
      const namespaceAliasUse = mainText.lastIndexOf("original.marker");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, namespaceAliasUse + 1, workspace),
        {
          fileName: mainFile,
          range: {
            start: namespaceAliasDeclaration,
            end: namespaceAliasDeclaration + "original".length
          }
        }
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(document, namespaceAliasUse + 1, false, workspace)
          .filter(location => location.fileName === mainFile)
          .map(location => location.range.start),
        [mainText.indexOf("original.marker"), namespaceAliasUse]
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
