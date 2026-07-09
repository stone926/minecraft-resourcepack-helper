import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getRsglDocumentCompletionItems,
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
        "template cube(id: ResourceId, texture: TextureId = id) {",
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
});

function tokenAt<T extends { start: number }>(tokens: readonly T[], start: number): T {
  const token = tokens.find(candidate => candidate.start === start);
  assert.ok(token, `expected token at ${start}`);
  return token;
}
