import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  findRsglProjectConfig,
  getRsglDocumentReferenceLocations,
  resolveRsglNavigationSourceRoot,
  type RsglLanguageWorkspace,
  type RsglReferenceLocation
} from "../../src";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";
import { withTempDir } from "./helpers/fs";

describe("RSGL references", () => {
  it("keeps shadowed local bindings separate", () => {
    const text = [
      "let value = 1",
      "let first = value",
      "if true {",
      "  let value = 2",
      "  let nested = value",
      "}",
      "let second = value"
    ].join("\n");
    const fileName = path.resolve("references-shadowing.rsgl");
    const document = { fileName, getText: () => text };
    const workspace = fallbackWorkspace();
    const outerUse = text.lastIndexOf("value");

    const outerReferences = getRsglDocumentReferenceLocations(
      document,
      outerUse + 1,
      false,
      workspace
    );
    assert.deepStrictEqual(
      outerReferences.map(location => text.slice(location.range.start, location.range.end)),
      ["value", "value"]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, outerUse + 1, true, workspace)
        .map(location => text.slice(location.range.start, location.range.end)),
      ["value", "value", "value"]
    );

    const innerUse = text.indexOf("value", text.indexOf("nested"));
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, innerUse + 1, true, workspace)
        .map(location => text.slice(location.range.start, location.range.end)),
      ["value", "value"]
    );
  });

  it("links declarations, imports, re-exports, aliases, and uses across the source root", () => {
    withTempDir(root => {
      const sourceFile = path.join(root, "01-source.rsgl");
      const barrelFile = path.join(root, "02-barrel.rsgl");
      const mainFile = path.join(root, "03-入口 main.rsgl");
      const sourceText = [
        "let original = 1",
        "export { original as Public }"
      ].join("\n");
      const barrelText = "export { Public as Forwarded } from \"./01-source.rsgl\"";
      const mainText = [
        "import { Forwarded as local } from \"./02-barrel.rsgl\"",
        "let result = local"
      ].join("\n");
      fs.writeFileSync(sourceFile, sourceText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(mainFile, mainText);

      const cache = RsglWorkspaceSemanticCache.create();
      const workspace: RsglLanguageWorkspace = {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        loadProgramForNavigation: () => cache.loadProgramFromDirectory(root)
      };
      const document = { fileName: mainFile, getText: () => mainText };
      const useOffset = mainText.lastIndexOf("local");
      const references = getRsglDocumentReferenceLocations(
        document,
        useOffset + 1,
        true,
        workspace
      );

      assert.deepStrictEqual(referenceTexts(references, new Map([
        [sourceFile, sourceText],
        [barrelFile, barrelText],
        [mainFile, mainText]
      ])), new Map([
        [sourceFile, ["original", "original", "Public"]],
        [barrelFile, ["Public", "Forwarded"]],
        [mainFile, ["Forwarded", "local", "local"]]
      ]));

      const withoutDeclaration = getRsglDocumentReferenceLocations(
        document,
        useOffset + 1,
        false,
        workspace
      );
      assert.strictEqual(withoutDeclaration.length, references.length - 1);
      assert.strictEqual(
        withoutDeclaration.some(location =>
          location.fileName === sourceFile
          && location.range.start === sourceText.indexOf("original")
        ),
        false
      );
    }, "rsgl-references-别名-");
  });

  it("keeps value and type namespaces separate", () => {
    const text = [
      "type Shared = { name: String }",
      "let Shared = 1",
      "let typed: Shared = { name: \"stone\" }",
      "let copied = Shared"
    ].join("\n");
    const fileName = path.resolve("references-namespaces.rsgl");
    const document = { fileName, getText: () => text };
    const workspace = fallbackWorkspace();
    const typeUse = text.indexOf("Shared", text.indexOf("typed"));
    const valueUse = text.lastIndexOf("Shared");

    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, typeUse + 1, true, workspace)
        .map(location => location.range.start),
      [text.indexOf("Shared"), typeUse]
    );
    assert.deepStrictEqual(
      getRsglDocumentReferenceLocations(document, valueUse + 1, true, workspace)
        .map(location => location.range.start),
      [text.indexOf("Shared", text.indexOf("let Shared")), valueUse]
    );
  });

  it("finds reverse importers from a nested declaration in a configured source root", () => {
    withTempDir(projectRoot => {
      const sourceRoot = path.join(projectRoot, "source files");
      const libraryDirectory = path.join(sourceRoot, "lib");
      const definitionFile = path.join(libraryDirectory, "definition.rsgl");
      const mainFile = path.join(sourceRoot, "main.rsgl");
      const definitionText = "let shared = 1\nexport { shared }";
      const mainText = [
        "import { shared } from \"./lib/definition.rsgl\"",
        "let copied = shared"
      ].join("\n");
      fs.mkdirSync(libraryDirectory, { recursive: true });
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(mainFile, mainText);

      const cache = RsglWorkspaceSemanticCache.create();
      const navigationRoot = resolveRsglNavigationSourceRoot(definitionFile, {
        configuredRoot: sourceRoot
      });
      const workspace: RsglLanguageWorkspace = {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        loadProgramForNavigation: () => cache.loadProgramFromDirectory(navigationRoot)
      };
      const declarationStart = definitionText.indexOf("shared");
      const locations = getRsglDocumentReferenceLocations(
        { fileName: definitionFile, getText: () => definitionText },
        declarationStart + 1,
        true,
        workspace
      );

      assert.deepStrictEqual(referenceTexts(locations, new Map([
        [definitionFile, definitionText],
        [mainFile, mainText]
      ])), new Map([
        [definitionFile, ["shared", "shared"]],
        [mainFile, ["shared", "shared"]]
      ]));
    }, "rsgl-references-reverse-import-");
  });

  it("finds a sibling reverse importer from an initialized workspace without config or src", () => {
    withTempDir(workspaceRoot => {
      const libraryDirectory = path.join(workspaceRoot, "pack", "lib");
      const definitionFile = path.join(libraryDirectory, "定义.rsgl");
      const mainFile = path.join(workspaceRoot, "pack", "main.rsgl");
      const definitionText = "let shared = 1\nexport { shared }";
      const mainText = [
        "import { shared } from \"./lib/定义.rsgl\"",
        "let copied = shared"
      ].join("\n");
      fs.mkdirSync(libraryDirectory, { recursive: true });
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(mainFile, mainText);

      const navigationRoot = resolveRsglNavigationSourceRoot(definitionFile, {
        projectRoots: [path.join(workspaceRoot, "pack")]
      });
      const cache = RsglWorkspaceSemanticCache.create();
      const locations = getRsglDocumentReferenceLocations(
        { fileName: definitionFile, getText: () => definitionText },
        definitionText.indexOf("shared") + 1,
        true,
        {
          loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
          loadProgramForNavigation: () => cache.loadProgramFromDirectory(navigationRoot)
        }
      );

      assert.deepStrictEqual(referenceTexts(locations, new Map([
        [definitionFile, definitionText],
        [mainFile, mainText]
      ])), new Map([
        [definitionFile, ["shared", "shared"]],
        [mainFile, ["shared", "shared"]]
      ]));
    }, "rsgl-references-workspace-boundary-");
  });

  it("isolates reverse importers at the nearest config boundary even while it is malformed", () => {
    withTempDir(workspaceRoot => {
      const outerSourceRoot = path.join(workspaceRoot, "src");
      const projectRoot = path.join(outerSourceRoot, "项目 A");
      const siblingRoot = path.join(outerSourceRoot, "项目 B");
      const libraryDirectory = path.join(projectRoot, "lib");
      const definitionFile = path.join(libraryDirectory, "definition.rsgl");
      const mainFile = path.join(projectRoot, "main.rsgl");
      const siblingFile = path.join(siblingRoot, "main.rsgl");
      const definitionText = "let shared = 1\nexport { shared }";
      const mainText = [
        "import { shared } from \"./lib/definition.rsgl\"",
        "let local = shared"
      ].join("\n");
      const siblingText = [
        "import { shared } from \"../项目 A/lib/definition.rsgl\"",
        "let leaked = shared"
      ].join("\n");
      fs.mkdirSync(libraryDirectory, { recursive: true });
      fs.mkdirSync(siblingRoot, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), "{");
      fs.writeFileSync(path.join(siblingRoot, "rsgl.config.json"), "{}");
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(mainFile, mainText);
      fs.writeFileSync(siblingFile, siblingText);

      const projectConfigFile = findRsglProjectConfig(definitionFile);
      assert.ok(projectConfigFile);
      const navigationRoot = resolveRsglNavigationSourceRoot(definitionFile, {
        projectRoots: [path.dirname(projectConfigFile), workspaceRoot]
      });
      assert.strictEqual(navigationRoot, projectRoot);

      const cache = RsglWorkspaceSemanticCache.create();
      const locations = getRsglDocumentReferenceLocations(
        { fileName: definitionFile, getText: () => definitionText },
        definitionText.indexOf("shared") + 1,
        true,
        {
          loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
          loadProgramForNavigation: () => cache.loadProgramFromDirectory(navigationRoot)
        }
      );

      assert.deepStrictEqual(referenceTexts(locations, new Map([
        [definitionFile, definitionText],
        [mainFile, mainText],
        [siblingFile, siblingText]
      ])), new Map([
        [definitionFile, ["shared", "shared"]],
        [mainFile, ["shared", "shared"]]
      ]));
    }, "rsgl-references-nested-config-");
  });
});

function fallbackWorkspace(): RsglLanguageWorkspace {
  return {
    loadProgramFromEntry(): never {
      throw new Error("Use the open-document fallback.");
    }
  };
}

function referenceTexts(
  locations: readonly RsglReferenceLocation[],
  sourceByFile: ReadonlyMap<string, string>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const location of locations) {
    const source = sourceByFile.get(location.fileName);
    assert.ok(source, `Missing source for ${location.fileName}`);
    const texts = result.get(location.fileName) ?? [];
    texts.push(source.slice(location.range.start, location.range.end));
    result.set(location.fileName, texts);
  }
  return result;
}
