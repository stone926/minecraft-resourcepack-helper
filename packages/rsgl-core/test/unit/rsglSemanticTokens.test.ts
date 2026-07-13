import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram, type RsglSemanticModel, type RsglSymbol } from "../../src/semantic";
import {
  getRsglSemanticTokens,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  type RsglSemanticToken
} from "../../src/semanticTokens";

const tokenType = (name: string): number => {
  const index = rsglSemanticTokenTypes.indexOf(name);
  assert.ok(index >= 0, `legend is missing token type '${name}'`);
  return index;
};

const modifier = (name: string): number => {
  const index = rsglSemanticTokenModifiers.indexOf(name);
  assert.ok(index >= 0, `legend is missing token modifier '${name}'`);
  return 1 << index;
};

function offsetOf(source: string, needle: string, occurrence = 0): number {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = source.indexOf(needle, index + 1);
    assert.ok(index >= 0, `expected occurrence #${i} of '${needle}' in source`);
  }
  return index;
}

function tokenAt(tokens: readonly RsglSemanticToken[], start: number): RsglSemanticToken {
  const token = tokens.find(candidate => candidate.start === start);
  assert.ok(token, `expected a semantic token starting at offset ${start}`);
  return token;
}

function expectToken(
  tokens: readonly RsglSemanticToken[],
  start: number,
  expectedType: string,
  expectedModifiers: number,
  expectedLength: number
): void {
  const token = tokenAt(tokens, start);
  assert.strictEqual(token.tokenType, tokenType(expectedType), `token type at offset ${start}`);
  assert.strictEqual(token.tokenModifiers, expectedModifiers, `token modifiers at offset ${start}`);
  assert.strictEqual(token.length, expectedLength, `token length at offset ${start}`);
}

describe("RSGL semantic tokens", () => {
  const declaration = modifier("declaration");
  const readonlyFlag = modifier("readonly");
  const defaultLibrary = modifier("defaultLibrary");

  const source = [
    "namespace minecraft",
    "import { woods as woodTable } from \"./woods.rsgl\"",
    "let base = \"acacia\"",
    "table sizes { small: 1 }",
    "template cube(id: ResourceId, suffix = base) {",
    "  model block id {",
    "    parent minecraft:block/cube_all",
    "    textures { all: suffix }",
    "  }",
    "}",
    "use cube(id: acacia_planks)",
    "let frames = seq(\"frame_{}\", pad: 2)",
    "model block acacia_planks {",
    "  parent minecraft:block/cube_all",
    "  textures { all: base }",
    "}"
  ].join("\n");

  const model = bindRsglModule(parseRsgl(source), { fileName: path.join("pack", "main.rsgl") });
  const tokens = getRsglSemanticTokens(model);

  it("classifies declarations with the declaration modifier", () => {
    expectToken(tokens, offsetOf(source, "woodTable"), "variable", declaration, "woodTable".length);
    expectToken(tokens, offsetOf(source, "base"), "variable", declaration | readonlyFlag, "base".length);
    expectToken(tokens, offsetOf(source, "sizes"), "variable", declaration, "sizes".length);
    expectToken(tokens, offsetOf(source, "cube("), "function", declaration, "cube".length);
    expectToken(tokens, offsetOf(source, "id: ResourceId"), "parameter", declaration, "id".length);
    expectToken(tokens, offsetOf(source, "suffix"), "parameter", declaration, "suffix".length);
    expectToken(tokens, offsetOf(source, "frames"), "variable", declaration | readonlyFlag, "frames".length);
  });

  it("classifies references without the declaration modifier", () => {
    expectToken(tokens, offsetOf(source, "base", 1), "variable", readonlyFlag, "base".length);
    expectToken(tokens, offsetOf(source, "base", 2), "variable", readonlyFlag, "base".length);
    expectToken(tokens, offsetOf(source, "suffix", 1), "parameter", 0, "suffix".length);
    expectToken(tokens, offsetOf(source, "cube(", 1), "function", 0, "cube".length);
  });

  it("marks builtin callables as default-library functions", () => {
    expectToken(tokens, offsetOf(source, "seq("), "function", defaultLibrary, "seq".length);
  });

  it("marks literal resource declaration names as types", () => {
    const start = offsetOf(source, "model block acacia_planks") + "model block ".length;
    expectToken(tokens, start, "type", declaration, "acacia_planks".length);
  });

  it("tokenizes base and merge operands without overriding keyword highlighting", () => {
    const mergeSource = [
      "let basePath = \"./base.json\"",
      "let fragment = { display: {} }",
      "model block patched {",
      "  base basePath",
      "  merge fragment",
      "  merge deep fragment",
      "  merge strict fragment",
      "  merge upsert fragment",
      "  merge append fragment",
      "}"
    ].join("\n");
    const mergeTokens = getRsglSemanticTokens(bindRsglModule(parseRsgl(mergeSource)));

    expectToken(mergeTokens, offsetOf(mergeSource, "basePath", 1), "variable", readonlyFlag, "basePath".length);
    for (let occurrence = 1; occurrence <= 5; occurrence++) {
      expectToken(mergeTokens, offsetOf(mergeSource, "fragment", occurrence), "variable", readonlyFlag, "fragment".length);
    }

    const keywordOffsets = [
      offsetOf(mergeSource, "  base ") + 2,
      ...[0, 1, 2, 3, 4].map(occurrence => offsetOf(mergeSource, "merge", occurrence)),
      offsetOf(mergeSource, "deep"),
      offsetOf(mergeSource, "strict"),
      offsetOf(mergeSource, "upsert"),
      offsetOf(mergeSource, "append")
    ];
    assert.ok(keywordOffsets.every(start => !mergeTokens.some(token => token.start === start)));
  });

  it("classifies resource property statements as properties", () => {
    expectToken(tokens, offsetOf(source, "parent minecraft"), "property", 0, "parent".length);

    const literalSource = "model block sample { \"quoted\" 1\n  123 2 }";
    const literalModule = parseRsgl(literalSource);
    assert.deepStrictEqual(literalModule.diagnostics, []);
    const literalTokens = getRsglSemanticTokens(bindRsglModule(literalModule));
    assert.ok(!literalTokens.some(token => token.start === offsetOf(literalSource, "\"quoted\"")));
    assert.ok(!literalTokens.some(token => token.start === offsetOf(literalSource, "123")));
  });

  it("keeps parameter-bound resource ids as references, not declarations", () => {
    const start = offsetOf(source, "model block id") + "model block ".length;
    expectToken(tokens, start, "parameter", 0, "id".length);
  });

  it("does not tokenize namespace text, string literals, or resource locations", () => {
    assert.ok(!tokens.some(token => token.start === offsetOf(source, "minecraft")), "namespace name");
    assert.ok(!tokens.some(token => token.start === offsetOf(source, "acacia_planks")), "use argument value");
    for (const token of tokens) {
      const text = source.slice(token.start, token.start + token.length);
      assert.match(text, /^[A-Za-z_][A-Za-z0-9_]*$/, `token text '${text}' must be a single identifier`);
      assert.ok(!text.includes("\n"), "tokens must be single-line");
    }
  });

  it("classifies object keys, named arguments, and member names as properties", () => {
    const contextualSource = [
      "template collect(parent: ModelId, model: ModelId) {",
      "  let record = { parent: parent, model: model }",
      "  let selected = record.model",
      "  let frames = seq(\"frame_{}\", pad: 2)",
      "  let commented = { extern /* multi",
      "  line */: \"value\" }",
      "}",
      "blockstate multipart demo {",
      "  apply minecraft:block/foo y=90 uvlock=true weight=2",
      "}"
    ].join("\n");
    const contextualModule = parseRsgl(contextualSource);
    assert.deepStrictEqual(contextualModule.diagnostics, []);
    const contextualTokens = getRsglSemanticTokens(bindRsglModule(contextualModule));
    const parentKey = offsetOf(contextualSource, "parent: parent");
    const modelKey = offsetOf(contextualSource, "model: model");
    const memberName = offsetOf(contextualSource, ".model") + 1;
    const namedArgument = offsetOf(contextualSource, "pad: 2");
    const sugarProperty = offsetOf(contextualSource, "y=90");
    const uvlockProperty = offsetOf(contextualSource, "uvlock");
    const weightProperty = offsetOf(contextualSource, "weight=2");
    const commentedKey = offsetOf(contextualSource, "extern /* multi");

    expectToken(contextualTokens, parentKey, "property", 0, "parent".length);
    expectToken(contextualTokens, modelKey, "property", 0, "model".length);
    expectToken(contextualTokens, memberName, "property", 0, "model".length);
    expectToken(contextualTokens, namedArgument, "property", 0, "pad".length);
    expectToken(contextualTokens, sugarProperty, "property", 0, "y".length);
    expectToken(contextualTokens, uvlockProperty, "property", 0, "uvlock".length);
    expectToken(contextualTokens, weightProperty, "property", 0, "weight".length);
    expectToken(contextualTokens, commentedKey, "property", 0, "extern".length);
    expectToken(
      contextualTokens,
      offsetOf(contextualSource, "seq("),
      "function",
      defaultLibrary,
      "seq".length
    );
    expectToken(
      contextualTokens,
      offsetOf(contextualSource, "record", 1),
      "variable",
      readonlyFlag,
      "record".length
    );
    expectToken(
      contextualTokens,
      parentKey + "parent: ".length,
      "parameter",
      0,
      "parent".length
    );
    expectToken(
      contextualTokens,
      modelKey + "model: ".length,
      "parameter",
      0,
      "model".length
    );
  });

  it("returns sorted, non-overlapping tokens", () => {
    let lastEnd = -1;
    for (const token of tokens) {
      assert.ok(token.length > 0, "token lengths must be positive");
      assert.ok(token.start >= lastEnd, `token at ${token.start} overlaps the previous token`);
      lastEnd = token.start + token.length;
    }
  });

  it("classifies imported template aliases as functions after program linking", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const mainText = [
      "import { cube as cubeModel } from \"./templates.rsgl\"",
      "use cubeModel(stone, texture: minecraft:block/stone)"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainText) },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template cube(id: ResourceId, texture: TextureId = id) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: texture }",
          "  }",
          "}"
        ].join("\n"))
      }
    ]);
    const mainModel = program.models.find(candidate => candidate.fileName === mainFile);
    assert.ok(mainModel, "expected the entry model to be bound");

    const mainTokens = getRsglSemanticTokens(mainModel);
    expectToken(mainTokens, offsetOf(mainText, "cubeModel"), "function", declaration, "cubeModel".length);
    expectToken(mainTokens, offsetOf(mainText, "cubeModel", 1), "function", 0, "cubeModel".length);
  });

  it("classifies local model ids passed to linked imported templates as variables", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const mainText = [
      "import { slab } from \"./templates.rsgl\"",
      "let model = `minecraft:block/custom_slab`",
      "blockstate custom_slab {",
      "  use slab(",
      "    bottom: model,",
      "    top: `${model}_top`,",
      "    double: `${model}_double`",
      "  )",
      "}"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainText) },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template slab(bottom: ModelId, top: ModelId, double: ModelId) -> variants {",
          "  { type: \"bottom\" }: bottom",
          "  { type: \"top\" }: top",
          "  { type: \"double\" }: double",
          "}"
        ].join("\n"))
      }
    ]);
    const mainModel = program.models.find(candidate => candidate.fileName === mainFile);
    assert.ok(mainModel, "expected the entry model to be bound");

    const referenceOffsets = [1, 2, 3].map(occurrence => offsetOf(mainText, "model", occurrence));
    assert.deepStrictEqual(
      mainModel.references.filter(reference => reference.name === "model").map(reference => reference.range.start),
      referenceOffsets
    );
    const mainTokens = getRsglSemanticTokens(mainModel);
    expectToken(mainTokens, offsetOf(mainText, "model"), "variable", declaration | readonlyFlag, "model".length);
    for (const referenceOffset of referenceOffsets) {
      expectToken(mainTokens, referenceOffset, "variable", readonlyFlag, "model".length);
    }
  });

  it("uses only standard VS Code token types and modifiers", () => {
    const standardTypes = new Set([
      "namespace", "class", "enum", "interface", "struct", "typeParameter", "type", "parameter",
      "variable", "property", "enumMember", "decorator", "event", "function", "method", "macro",
      "label", "comment", "string", "keyword", "number", "regexp", "operator"
    ]);
    const standardModifiers = new Set([
      "declaration", "definition", "readonly", "static", "deprecated", "abstract",
      "async", "modification", "documentation", "defaultLibrary"
    ]);
    for (const name of rsglSemanticTokenTypes) {
      assert.ok(standardTypes.has(name), `non-standard token type '${name}'`);
    }
    for (const name of rsglSemanticTokenModifiers) {
      assert.ok(standardModifiers.has(name), `non-standard token modifier '${name}'`);
    }
  });

  it("drops overlapping candidates deterministically and keeps adjacent tokens", () => {
    const variableSymbol: RsglSymbol = {
      name: "value",
      kind: "variable",
      type: { kind: "String" },
      range: { start: 10, end: 14 }
    };
    const model: RsglSemanticModel = {
      fileName: "synthetic.rsgl",
      module: parseRsgl(""),
      scope: { kind: "module", symbols: new Map() },
      symbols: [variableSymbol],
      imports: [],
      exports: [],
      references: [
        // Same start as the declaration but longer: declaration must win the tie.
        { name: "value", range: { start: 10, end: 18 }, symbol: variableSymbol },
        // Enclosed by the declaration range: must be dropped.
        { name: "value", range: { start: 12, end: 15 }, symbol: variableSymbol },
        // Starts exactly at the declaration's end: adjacent, must be kept.
        { name: "value", range: { start: 14, end: 17 }, symbol: variableSymbol }
      ],
      outputResources: [],
      diagnostics: []
    };

    assert.deepStrictEqual(getRsglSemanticTokens(model), [
      { start: 10, length: 4, tokenType: tokenType("variable"), tokenModifiers: readonlyFlag | declaration },
      { start: 14, length: 3, tokenType: tokenType("variable"), tokenModifiers: readonlyFlag }
    ]);
  });
});
