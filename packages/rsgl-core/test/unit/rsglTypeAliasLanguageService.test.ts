import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  getRsglDocumentReferenceLocations
} from "../../src/languageService";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";

describe("RSGL type alias language service", () => {
  it("provides completion, hover, and original definitions through re-exports", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-类型 工具-"));
    try {
      const sourceFile = path.join(temp, "原始类型.rsgl");
      const barrelFile = path.join(temp, "barrel.rsgl");
      const mainFile = path.join(temp, "入口.rsgl");
      const sourceText = [
        "type Original = { name: String; top?: TextureId }",
        "export { Original as Public }"
      ].join("\n");
      const barrelText = "export { Public as Forwarded } from \"./原始类型.rsgl\"";
      const mainText = [
        "import { Forwarded as Local } from \"./barrel.rsgl\"",
        "let entry: Local = { name: \"wheat\" }"
      ].join("\n");
      fs.writeFileSync(sourceFile, sourceText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(mainFile, mainText);

      const cache = RsglWorkspaceSemanticCache.create();
      const workspace = {
        loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName),
        loadProgramForNavigation: () => cache.loadProgramFromDirectory(temp)
      };
      const mainDocument = { fileName: mainFile, getText: () => mainText };
      const annotationOffset = mainText.lastIndexOf("Local");
      assert.deepStrictEqual(getRsglDocumentHoverInfo(mainDocument, annotationOffset + 2, workspace), {
        range: { start: annotationOffset, end: annotationOffset + "Local".length },
        label: "type Local = { name: String, top?: TextureId }"
      });

      const originalStart = sourceText.indexOf("Original");
      const expectedDefinition = {
        fileName: sourceFile,
        range: { start: originalStart, end: originalStart + "Original".length }
      };
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(mainDocument, annotationOffset + 2, workspace),
        expectedDefinition
      );
      const importedOffset = mainText.indexOf("Forwarded");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(mainDocument, importedOffset + 2, workspace),
        expectedDefinition
      );

      const barrelDocument = { fileName: barrelFile, getText: () => barrelText };
      const reExportOffset = barrelText.indexOf("Forwarded");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(barrelDocument, reExportOffset + 2, workspace),
        expectedDefinition
      );

      const references = getRsglDocumentReferenceLocations(
        mainDocument,
        annotationOffset + 2,
        true,
        workspace
      );
      const referenceTexts = new Map<string, string[]>();
      const sources = new Map([
        [sourceFile, sourceText],
        [barrelFile, barrelText],
        [mainFile, mainText]
      ]);
      for (const reference of references) {
        const source = sources.get(reference.fileName);
        assert.ok(source);
        const texts = referenceTexts.get(reference.fileName) ?? [];
        texts.push(source.slice(reference.range.start, reference.range.end));
        referenceTexts.set(reference.fileName, texts);
      }
      assert.deepStrictEqual(referenceTexts, new Map([
        [sourceFile, ["Original", "Original", "Public"]],
        [barrelFile, ["Public", "Forwarded"]],
        [mainFile, ["Forwarded", "Local", "Local"]]
      ]));

      const completion = getRsglDocumentCompletionItems(mainDocument, mainText.length, workspace)
        .find(item => item.label === "Local");
      assert.deepStrictEqual(completion, {
        label: "Local",
        kind: "struct",
        detail: "type alias: { name: String, top?: TextureId }"
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
