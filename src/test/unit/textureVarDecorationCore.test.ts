import * as assert from "node:assert/strict";
import { collectUndefinedTextureVariableRanges } from "../../decorator/textureVarDecorationCore";
import { parseJsonAst, type JsonDocumentNode } from "../../utils/jsonAst";
import type { LineCharacterRange } from "../../utils/astLocationRanges";

describe("texture variable decoration core", () => {
  it("returns exact source ranges only for unresolved local and face references", () => {
    const text = [
      "{",
      "  \"textures\": {",
      "    \"base\": \"example:block/stone\",",
      "    \"alias\": \"#base\",",
      "    \"inheritedAlias\": \"#inherited\",",
      "    \"brokenAlias\": \"#missing\"",
      "  },",
      "  \"elements\": [{",
      "    \"faces\": {",
      "      \"north\": { \"texture\": \"#base\" },",
      "      \"south\": { \"texture\": \"#external\" },",
      "      \"east\": { \"texture\": \"#missing\" }",
      "    }",
      "  }]",
      "}"
    ].join("\n");
    const inheritedLookups: string[] = [];
    const ranges = collectUndefinedTextureVariableRanges(parseModel(text), reference => {
      inheritedLookups.push(reference);
      return reference === "#inherited" || reference === "#external";
    });

    assert.deepStrictEqual(ranges.map(range => selectedText(text, range)), [
      "\"#missing\"",
      "\"#missing\""
    ]);
    assert.deepStrictEqual(inheritedLookups, ["#inherited", "#missing", "#external", "#missing"]);
  });

  it("returns no ranges when every variable resolves through the inherited lookup", () => {
    const text = "{\n  \"textures\": { \"alias\": \"#parent\" }\n}";
    const ranges = collectUndefinedTextureVariableRanges(parseModel(text), () => true);

    assert.deepStrictEqual(ranges, []);
  });
});

function parseModel(text: string): JsonDocumentNode {
  const ast = parseJsonAst(text);
  assert.ok(ast, `Expected valid model JSON, received: ${text}`);
  return ast;
}

function selectedText(text: string, range: LineCharacterRange): string {
  assert.strictEqual(range.start.line, range.end.line, "Test fixture expects a single-line JSON string range");
  return text.split("\n")[range.start.line].slice(range.start.character, range.end.character);
}
