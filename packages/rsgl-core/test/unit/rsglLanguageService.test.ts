import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  getRsglDocumentRenameEdits,
  getRsglDocumentSignatureHelpInfo,
  getRsglDocumentSemanticTokens,
  prepareRsglDocumentRename
} from "../../src/languageService";
import {
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes
} from "../../src/semanticTokens";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";

const functionTokenType = rsglSemanticTokenTypes.indexOf("function");
const namespaceTokenType = rsglSemanticTokenTypes.indexOf("namespace");
const variableTokenType = rsglSemanticTokenTypes.indexOf("variable");
const declarationModifier = 1 << rsglSemanticTokenModifiers.indexOf("declaration");

describe("RSGL language service", () => {
  it("resolves completions and semantic tokens through the same workspace model", () => {
    assert.ok(functionTokenType >= 0, "semantic token legend should include function");
    assert.ok(declarationModifier > 0, "semantic token legend should include declaration");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-language-"));
    try {
      const mainFile = path.join(root, "main.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      const mainText = [
        "import { cube as cubeModel } from \"./templates.rsgl\"",
        "use cubeModel(stone, texture: minecraft:block/stone)"
      ].join("\n");
      fs.writeFileSync(mainFile, mainText);
      fs.writeFileSync(templatesFile, [
        "template cube(id: TextureId, texture: TextureId = id) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}",
        "export { cube }"
      ].join("\n"));

      const cache = RsglWorkspaceSemanticCache.create();
      const document = {
        fileName: mainFile,
        getText: () => mainText
      };

      const completions = getRsglDocumentCompletionItems(document, mainText.length, cache);
      assert.ok(completions.some(item => item.label === "cubeModel"));

      const tokens = getRsglDocumentSemanticTokens(document, cache);
      assert.deepStrictEqual(tokenAt(tokens, mainText.indexOf("cubeModel")), {
        start: mainText.indexOf("cubeModel"),
        length: "cubeModel".length,
        tokenType: functionTokenType,
        tokenModifiers: declarationModifier
      });
      assert.deepStrictEqual(tokenAt(tokens, mainText.indexOf("cubeModel", mainText.indexOf("cubeModel") + 1)), {
        start: mainText.indexOf("cubeModel", mainText.indexOf("cubeModel") + 1),
        length: "cubeModel".length,
        tokenType: functionTokenType,
        tokenModifiers: 0
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps merge completions everywhere in resource bodies and scopes base to the root start", () => {
    const unavailableWorkspace = {
      loadProgramFromEntry(): never {
        throw new Error("Use the open document fallback.");
      }
    };
    const completions = (text: string) => getRsglDocumentCompletionItems({
      fileName: "memory.rsgl",
      getText: () => text
    }, text.length, unavailableWorkspace);

    const root = completions("model block stone {\n  ");
    assert.ok(root.some(item => item.label === "base"));
    assert.ok(root.some(item => item.label === "merge append"));

    const nested = completions("model block stone {\n  textures {\n    ");
    assert.strictEqual(nested.some(item => item.label === "base"), false);
    assert.ok(nested.some(item => item.label === "merge deep"));
  });

  it("provides target-aware item-model schema hover without workspace dependencies", () => {
    const text = [
      "target java format [82, 0]",
      "item example {",
      "  select property minecraft:component component minecraft:custom_data {",
      "    case [{ value: 1 }] => special base minecraft:item/example model {",
      "      type: minecraft:shulker_box,",
      "      texture: \"example\",",
      "      orientation: north",
      "    }",
      "    fallback minecraft:item/example",
      "  }",
      "}"
    ].join("\n");
    const document = { fileName: path.resolve("item-schema-hover.rsgl"), getText: () => text };
    let projectTargetLookups = 0;
    const fallbackWorkspace = {
      loadProgramFromEntry(): never {
        throw new Error("Use the open document fallback.");
      },
      projectItemModelTargetFormatForSource(): never {
        projectTargetLookups++;
        throw new Error("A file target must bypass project target lookup.");
      }
    };

    const propertyStart = text.indexOf("minecraft:component");
    const propertyHover = getRsglDocumentHoverInfo(document, propertyStart + 3, fallbackWorkspace);
    assert.strictEqual(propertyHover?.label, "item select property minecraft:component");
    assert.ok(propertyHover?.detail?.includes("complete equality"));

    const optionStart = text.indexOf("component minecraft:custom_data");
    const optionHover = getRsglDocumentHoverInfo(document, optionStart + 2, fallbackWorkspace);
    assert.strictEqual(optionHover?.label, "component: resourceId");
    assert.ok(optionHover?.detail?.includes("Required"));

    const whenStart = text.indexOf("[{ value");
    const whenHover = getRsglDocumentHoverInfo(document, whenStart + 1, fallbackWorkspace);
    assert.ok(whenHover?.detail?.includes("not as subsets"));

    const orientationStart = text.indexOf("orientation");
    const orientationHover = getRsglDocumentHoverInfo(document, orientationStart + 2, fallbackWorkspace);
    assert.strictEqual(orientationHover?.label, "orientation?: enum");
    assert.ok(orientationHover?.detail?.includes("down, up, north"));
    assert.strictEqual(projectTargetLookups, 0);
  });

  it("resolves hover, signature help, and definitions through aliases and re-exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-intelligence-"));
    try {
      const mainFile = path.join(root, "main.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      const mainText = [
        "import { forwardedCube as buildCube } from \"./barrel.rsgl\"",
        "model block example {",
        "  use buildCube(minecraft:block/example, texture: minecraft:block/stone)",
        "}"
      ].join("\n");
      const barrelText = "export { exportedCube as forwardedCube } from \"./templates.rsgl\"";
      const templatesText = [
        "template cube(id: TextureId, texture: TextureId = id) -> model {",
        "}",
        "export { cube as exportedCube }"
      ].join("\n");
      fs.writeFileSync(mainFile, mainText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(templatesFile, templatesText);

      const cache = RsglWorkspaceSemanticCache.create();
      const document = { fileName: mainFile, getText: () => mainText };
      const referenceOffset = mainText.lastIndexOf("buildCube");
      const hover = getRsglDocumentHoverInfo(document, referenceOffset + 2, cache);

      assert.deepStrictEqual(hover, {
        range: { start: referenceOffset, end: referenceOffset + "buildCube".length },
        label: "template buildCube(id: TextureId, texture: TextureId = ...): Json",
        detail: "template -> model"
      });

      const textureArgumentOffset = mainText.lastIndexOf("minecraft:block/stone") + 5;
      const signature = getRsglDocumentSignatureHelpInfo(document, textureArgumentOffset, cache);
      assert.strictEqual(signature?.signatures[0].label, "buildCube(id: TextureId, texture: TextureId = ...): Json");
      assert.strictEqual(signature?.activeParameter, 1, "named arguments select their declared parameter");

      const definition = getRsglDocumentDefinitionLocation(document, referenceOffset + 2, cache);
      const definitionStart = templatesText.indexOf("cube");
      assert.deepStrictEqual(definition, {
        fileName: templatesFile,
        range: { start: definitionStart, end: definitionStart + "cube".length }
      });

      const importAliasOffset = mainText.indexOf("forwardedCube");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, importAliasOffset + 1, cache),
        definition,
        "the imported side of an aliased import should resolve through the re-export chain"
      );

      const barrelDocument = { fileName: barrelFile, getText: () => barrelText };
      const reExportAliasOffset = barrelText.indexOf("forwardedCube");
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(barrelDocument, reExportAliasOffset + 1, cache),
        definition,
        "the exported side of a re-export alias should resolve to the original declaration"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers semantic tooling for locally inferred function values", () => {
    const text = [
      "let identity = (value) => value",
      "let result = identity(1)"
    ].join("\n");
    const fileName = path.resolve("function-tooling.rsgl");
    const document = { fileName, getText: () => text };
    const fallbackWorkspace = {
      loadProgramFromEntry(): never {
        throw new Error("Use the open document fallback.");
      }
    };
    const referenceOffset = text.lastIndexOf("identity");

    const hover = getRsglDocumentHoverInfo(document, referenceOffset + 2, fallbackWorkspace);
    assert.ok(hover?.label.startsWith("identity("));
    assert.ok(hover?.label.endsWith(": Any"));
    assert.strictEqual(
      getRsglDocumentSignatureHelpInfo(document, text.indexOf("1)"), fallbackWorkspace)?.activeParameter,
      0
    );
    assert.deepStrictEqual(
      getRsglDocumentDefinitionLocation(document, referenceOffset + 2, fallbackWorkspace),
      {
        fileName,
        range: {
          start: text.indexOf("identity"),
          end: text.indexOf("identity") + "identity".length
        }
      }
    );
    assert.strictEqual(
      getRsglDocumentCompletionItems(document, text.length, fallbackWorkspace)
        .find(item => item.label === "identity")?.kind,
      "function"
    );
  });

  it("presents builtin rest parameters and keeps extra arguments on the rest slot", () => {
    const text = "let combined = concat([1], [2], [3])";
    const document = {
      fileName: path.resolve("collection-rest-tooling.rsgl"),
      getText: () => text
    };
    const fallbackWorkspace = {
      loadProgramFromEntry(): never {
        throw new Error("Use the open document fallback.");
      }
    };

    const signature = getRsglDocumentSignatureHelpInfo(
      document,
      text.lastIndexOf("[3]") + 1,
      fallbackWorkspace
    );

    assert.ok(signature?.signatures[0].label.startsWith("concat(...sources: "));
    assert.strictEqual(signature?.signatures[0].parameters[0].rest, true);
    assert.strictEqual(signature?.activeParameter, 0);
  });

  it("provides namespace-member completion, hover, signatures, definitions, and tokens through re-exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-namespace-tooling-"));
    try {
      const mainFile = path.join(root, "main.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const commonFile = path.join(root, "共享 common.rsgl");
      const commonText = [
        "let VALUE = \"stone\"",
        "let decorate: (String) -> String = value => `prefix/${value}`",
        "template cube(id: ModelId) -> model {",
        "  parent id",
        "}",
        "export { VALUE, decorate, cube }"
      ].join("\n");
      const mainText = [
        "import * as common from \"./barrel.rsgl\"",
        "let selected = common.VALUE",
        "let decorated = common.decorate(\"stone\")",
        "model block example {",
        "  use common.cube(minecraft:block/stone)",
        "}"
      ].join("\n");
      fs.writeFileSync(commonFile, commonText);
      fs.writeFileSync(barrelFile, [
        "import { VALUE as V } from \"./共享 common.rsgl\"",
        "export { V as VALUE }",
        "export { decorate, cube } from \"./共享 common.rsgl\""
      ].join("\n"));
      fs.writeFileSync(mainFile, mainText);

      const cache = RsglWorkspaceSemanticCache.create();
      const document = { fileName: mainFile, getText: () => mainText };
      const completionOffset = mainText.indexOf("common.VALUE") + "common.".length;
      const completions = getRsglDocumentCompletionItems(document, completionOffset, cache);
      assert.deepStrictEqual(
        completions.map(item => [item.label, item.kind]),
        [["VALUE", "variable"], ["decorate", "function"], ["cube", "function"]]
      );
      assert.strictEqual(
        getRsglDocumentCompletionItems(document, mainText.length, cache)
          .find(item => item.label === "common")?.kind,
        "module"
      );

      const valueOffset = mainText.indexOf("VALUE");
      assert.deepStrictEqual(getRsglDocumentHoverInfo(document, valueOffset + 1, cache), {
        range: { start: valueOffset, end: valueOffset + "VALUE".length },
        label: "value VALUE: \"stone\""
      });
      const cubeOffset = mainText.lastIndexOf("cube");
      const cubeHover = getRsglDocumentHoverInfo(document, cubeOffset + 1, cache);
      assert.strictEqual(cubeHover?.label, "template cube(id: ModelId): Json");
      assert.strictEqual(cubeHover?.detail, "template -> model");

      const callArgumentOffset = mainText.indexOf("\"stone\"") + 2;
      const signature = getRsglDocumentSignatureHelpInfo(document, callArgumentOffset, cache);
      assert.strictEqual(signature?.signatures[0].label, "common.decorate(value: String): String");
      assert.strictEqual(signature?.activeParameter, 0);

      const definition = getRsglDocumentDefinitionLocation(document, valueOffset + 1, cache);
      const valueDefinitionStart = commonText.indexOf("VALUE");
      assert.deepStrictEqual(definition, {
        fileName: commonFile,
        range: { start: valueDefinitionStart, end: valueDefinitionStart + "VALUE".length }
      });

      const tokens = getRsglDocumentSemanticTokens(document, cache);
      const aliasOffset = mainText.indexOf("common");
      const decorateOffset = mainText.indexOf("common.decorate") + "common.".length;
      assert.deepStrictEqual(tokenAt(tokens, aliasOffset), {
        start: aliasOffset,
        length: "common".length,
        tokenType: namespaceTokenType,
        tokenModifiers: declarationModifier
      });
      assert.strictEqual(tokenAt(tokens, valueOffset).tokenType, variableTokenType);
      assert.strictEqual(tokenAt(tokens, decorateOffset).tokenType, functionTokenType);
      assert.strictEqual(tokenAt(tokens, cubeOffset).tokenType, functionTokenType);

      assert.deepStrictEqual(prepareRsglDocumentRename(document, aliasOffset + 1, cache), {
        range: { start: aliasOffset, end: aliasOffset + "common".length },
        placeholder: "common"
      });
      const aliasEdits = getRsglDocumentRenameEdits(
        document,
        aliasOffset + 1,
        "shared",
        cache
      );
      assert.strictEqual(aliasEdits?.length, 4);
      assert.deepStrictEqual(new Set(aliasEdits?.map(edit => edit.fileName)), new Set([mainFile]));
      assert.ok(aliasEdits?.every(edit => edit.newText === "shared"));

      assert.deepStrictEqual(prepareRsglDocumentRename(document, valueOffset + 1, cache), {
        range: { start: valueOffset, end: valueOffset + "VALUE".length },
        placeholder: "VALUE"
      });
      const memberEdits = getRsglDocumentRenameEdits(
        document,
        valueOffset + 1,
        "RENAMED",
        cache
      );
      assert.ok(memberEdits);
      assert.strictEqual(memberEdits.length, 5);
      const renamedTexts = applyRenameEdits(
        new Map([
          [mainFile, mainText],
          [barrelFile, fs.readFileSync(barrelFile, "utf8")],
          [commonFile, commonText]
        ]),
        memberEdits
      );
      assert.ok(renamedTexts.get(mainFile)?.includes("common.RENAMED"));
      assert.ok(renamedTexts.get(barrelFile)?.includes("import { RENAMED as V }"));
      assert.ok(renamedTexts.get(barrelFile)?.includes("export { V as RENAMED }"));
      assert.ok(renamedTexts.get(commonFile)?.includes("let RENAMED = \"stone\""));
      assert.ok(renamedTexts.get(commonFile)?.includes("export { RENAMED, decorate, cube }"));
      assert.strictEqual(
        getRsglDocumentRenameEdits(document, valueOffset + 1, "not-valid!", cache),
        undefined
      );

      if (process.platform === "win32") {
        const caseVariantDocument = {
          fileName: mainFile.toUpperCase(),
          getText: () => mainText
        };
        const caseVariantEdits = getRsglDocumentRenameEdits(
          caseVariantDocument,
          valueOffset + 1,
          "CASE_RENAMED",
          cache
        );
        assert.ok(caseVariantEdits);
        assert.deepStrictEqual(
          new Set(caseVariantEdits.map(edit => edit.fileName)),
          new Set([mainFile, barrelFile, commonFile]),
          "case-insensitive lookup must preserve the first canonical display paths"
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function tokenAt<T extends { start: number }>(tokens: readonly T[], start: number): T {
  const token = tokens.find(candidate => candidate.start === start);
  assert.ok(token, `expected token at ${start}`);
  return token;
}

function applyRenameEdits(
  sources: ReadonlyMap<string, string>,
  edits: readonly { fileName: string; range: { start: number; end: number }; newText: string }[]
): Map<string, string> {
  const result = new Map(sources);
  for (const fileName of new Set(edits.map(edit => edit.fileName))) {
    let text = result.get(fileName)!;
    const fileEdits = edits
      .filter(edit => edit.fileName === fileName)
      .sort((left, right) => right.range.start - left.range.start);
    for (const edit of fileEdits) {
      text = text.slice(0, edit.range.start) + edit.newText + text.slice(edit.range.end);
    }
    result.set(fileName, text);
  }
  return result;
}
