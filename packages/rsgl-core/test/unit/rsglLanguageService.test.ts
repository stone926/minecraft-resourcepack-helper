import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  getRsglDocumentSignatureHelpInfo,
  getRsglDocumentSemanticTokens
} from "../../src/languageService";
import {
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes
} from "../../src/semanticTokens";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";

const functionTokenType = rsglSemanticTokenTypes.indexOf("function");
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
        "}"
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
});

function tokenAt<T extends { start: number }>(tokens: readonly T[], start: number): T {
  const token = tokens.find(candidate => candidate.start === start);
  assert.ok(token, `expected token at ${start}`);
  return token;
}
