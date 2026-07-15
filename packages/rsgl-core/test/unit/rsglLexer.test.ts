import * as assert from "node:assert";
import { rsglModelGeometryKeywords } from "../../src/modelGeometrySyntax";
import { lexRsgl } from "../../src/parser";

describe("RSGL lexer", () => {
  it("lexes comments, strings, numbers, and resource locations", () => {
    const result = lexRsgl([
      "// resource source",
      "target java format [88, 0]",
      "let texture = minecraft:block/acacia_planks",
      "let label = `minecraft:block/${wood}`"
    ].join("\n"));

    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.tokens.some(token => token.kind === "resourceLocation" && token.text === "minecraft:block/acacia_planks"));
    assert.ok(result.tokens.some(token => token.kind === "templateString"));
    assert.ok(result.tokens.some(token => token.kind === "number" && token.text === "88"));
  });

  it("tokenizes namespace import punctuation without introducing new keywords", () => {
    const result = lexRsgl("import * as common from \"./common.rsgl\"");
    const tokens = result.tokens.filter(token => token.kind !== "endOfFile");

    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(tokens.map(token => [token.kind, token.text]), [
      ["keyword", "import"],
      ["operator", "*"],
      ["keyword", "as"],
      ["identifier", "common"],
      ["keyword", "from"],
      ["string", "\"./common.rsgl\""]
    ]);
  });

  it("classifies the base and merge vocabulary", () => {
    const result = lexRsgl("base merge deep strict upsert append");
    const kinds = new Map(result.tokens.map(token => [token.text, token.kind]));

    for (const keyword of ["base", "merge", "deep", "strict", "upsert", "append"]) {
      assert.strictEqual(kinds.get(keyword), "keyword");
    }
  });

  it("lexes the blockstate rule vocabulary and state namespace", () => {
    const result = lexRsgl(
      "case part always when random option weight with choice not in $state $state_value"
    );
    const tokens = result.tokens.filter(token => token.kind !== "endOfFile");

    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(tokens.map(token => [token.kind, token.text]), [
      ["keyword", "case"],
      ["keyword", "part"],
      ["keyword", "always"],
      ["keyword", "when"],
      ["keyword", "random"],
      ["keyword", "option"],
      ["keyword", "weight"],
      ["keyword", "with"],
      ["keyword", "choice"],
      ["keyword", "not"],
      ["keyword", "in"],
      ["identifier", "$state"],
      ["identifier", "$state_value"]
    ]);
  });

  it("reserves type aliases without exposing fn or Missing as keywords", () => {
    const result = lexRsgl("type Record = { optional?: String } fn Missing");
    const kinds = new Map(result.tokens.map(token => [token.text, token.kind]));

    assert.strictEqual(kinds.get("type"), "keyword");
    assert.strictEqual(kinds.get("fn"), "identifier");
    assert.strictEqual(kinds.get("Missing"), "identifier");
    assert.ok(result.tokens.some(token => token.kind === "operator" && token.text === "?"));
  });

  it("matches ellipsis before range and dot tokens", () => {
    const result = lexRsgl("... .. . .... 1...2 1..2 1.2");
    const tokens = result.tokens.filter(token => token.kind !== "endOfFile");

    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(tokens.map(token => [token.kind, token.text]), [
      ["operator", "..."],
      ["operator", ".."],
      ["punctuation", "."],
      ["operator", "..."],
      ["punctuation", "."],
      ["number", "1"],
      ["operator", "..."],
      ["number", "2"],
      ["number", "1"],
      ["operator", ".."],
      ["number", "2"],
      ["number", "1.2"]
    ]);
  });

  it("classifies every model geometry descriptor keyword", () => {
    assert.strictEqual(
      new Set(rsglModelGeometryKeywords).size,
      rsglModelGeometryKeywords.length,
      "Model geometry descriptors must have unique keywords."
    );

    const result = lexRsgl(rsglModelGeometryKeywords.join(" "));
    const tokens = result.tokens.filter(token => token.kind !== "endOfFile");

    assert.deepStrictEqual(tokens.map(token => token.text), [...rsglModelGeometryKeywords]);
    for (const token of tokens) {
      assert.strictEqual(token.kind, "keyword", `Expected geometry keyword '${token.text}' to be lexed as a keyword.`);
    }
  });
});
