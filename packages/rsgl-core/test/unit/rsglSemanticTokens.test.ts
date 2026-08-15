import * as assert from "node:assert/strict";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram, type RsglSemanticModel, type RsglSymbol } from "../../src/semantic";
import {
  getRsglSemanticTokens,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  type RsglSemanticToken
} from "../../src/semanticTokens";

const tokenTypeIndices: Readonly<Record<string, number>> = Object.freeze({
  namespace: 0,
  type: 1,
  function: 2,
  variable: 3,
  parameter: 4,
  property: 5
});

const tokenModifierIndices: Readonly<Record<string, number>> = Object.freeze({
  declaration: 0,
  readonly: 1,
  defaultLibrary: 2
});

const tokenType = (name: string): number => {
  const index = tokenTypeIndices[name];
  assert.notStrictEqual(index, undefined, `test legend is missing token type '${name}'`);
  return index;
};

const modifier = (name: string): number => {
  const index = tokenModifierIndices[name];
  assert.notStrictEqual(index, undefined, `test legend is missing token modifier '${name}'`);
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
  it("keeps semantic analysis bounded after excessive expression nesting", () => {
    const depth = 2_048;
    const module = parseRsgl(`let nested = ${"[".repeat(depth)}0${"]".repeat(depth)}`);

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expressionNestingTooDeep"));
    assert.doesNotThrow(() => getRsglSemanticTokens(bindRsglModule(module)));
  });

  it("memoizes tokens for an unchanged bound semantic model", () => {
    const model = bindRsglModule(parseRsgl("let value = 1"));
    const first = getRsglSemanticTokens(model);

    assert.strictEqual(Object.isFrozen(first), true);
    assert.strictEqual(getRsglSemanticTokens(model), first);
    assert.notStrictEqual(
      getRsglSemanticTokens(bindRsglModule(parseRsgl("let value = 2"))),
      first
    );
  });

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

  it("classifies custom type aliases in generic annotations", () => {
    const typeSource = [
      "type SlabMaterial = { name: String }",
      "let slabMaterials: List<SlabMaterial> = [{ name: \"stone\" }]"
    ].join("\n");
    const typeTokens = getRsglSemanticTokens(bindRsglModule(parseRsgl(typeSource)));

    expectToken(typeTokens, offsetOf(typeSource, "SlabMaterial"), "type", declaration, "SlabMaterial".length);
    expectToken(typeTokens, offsetOf(typeSource, "SlabMaterial", 1), "type", 0, "SlabMaterial".length);
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
      "  part when $state.facing == north => random {",
      "    option minecraft:block/foo with { y: 90, uvlock: true } weight 2",
      "  }",
      "}"
    ].join("\n");
    const contextualModule = parseRsgl(contextualSource);
    assert.deepStrictEqual(contextualModule.diagnostics, []);
    const contextualTokens = getRsglSemanticTokens(bindRsglModule(contextualModule));
    const parentKey = offsetOf(contextualSource, "parent: parent");
    const modelKey = offsetOf(contextualSource, "model: model");
    const memberName = offsetOf(contextualSource, ".model") + 1;
    const namedArgument = offsetOf(contextualSource, "pad: 2");
    const stateProperty = offsetOf(contextualSource, ".facing") + 1;
    const modelProperty = offsetOf(contextualSource, "y: 90");
    const uvlockProperty = offsetOf(contextualSource, "uvlock");
    const weightKeyword = offsetOf(contextualSource, "weight 2");
    const commentedKey = offsetOf(contextualSource, "extern /* multi");

    expectToken(contextualTokens, parentKey, "property", 0, "parent".length);
    expectToken(contextualTokens, modelKey, "property", 0, "model".length);
    expectToken(contextualTokens, memberName, "property", 0, "model".length);
    expectToken(contextualTokens, namedArgument, "property", 0, "pad".length);
    expectToken(contextualTokens, stateProperty, "property", 0, "facing".length);
    expectToken(contextualTokens, modelProperty, "property", 0, "y".length);
    expectToken(contextualTokens, uvlockProperty, "property", 0, "uvlock".length);
    assert.ok(!contextualTokens.some(token => token.start === weightKeyword));
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

  it("distinguishes object loop properties from their local aliases", () => {
    const loopSource = [
      "for {name, models:m} in [{ name: \"fire\", models: [] }] {",
      "  let selected = m",
      "}"
    ].join("\n");
    const loopModule = parseRsgl(loopSource);
    assert.deepStrictEqual(loopModule.diagnostics, []);
    const loopTokens = getRsglSemanticTokens(bindRsglModule(loopModule));
    const shorthand = offsetOf(loopSource, "name");
    const property = offsetOf(loopSource, "models:m");
    const alias = property + "models:".length;
    const aliasReference = offsetOf(loopSource, "= m") + 2;

    // The shorthand identifier is simultaneously a property selection and a
    // local declaration; declaration classification wins on the shared range.
    expectToken(loopTokens, shorthand, "variable", declaration | readonlyFlag, "name".length);
    expectToken(loopTokens, property, "property", 0, "models".length);
    expectToken(loopTokens, alias, "variable", declaration | readonlyFlag, "m".length);
    expectToken(loopTokens, aliasReference, "variable", readonlyFlag, "m".length);
  });

  it("classifies explicit loop index declarations and references", () => {
    const source = [
      "for item at itemIndex in [a], variant at variantIndex in [itemIndex] {",
      "  let selected = variantIndex",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);
    const tokens = getRsglSemanticTokens(bindRsglModule(module));

    expectToken(
      tokens,
      offsetOf(source, "itemIndex"),
      "variable",
      declaration | readonlyFlag,
      "itemIndex".length
    );
    expectToken(
      tokens,
      offsetOf(source, "variantIndex"),
      "variable",
      declaration | readonlyFlag,
      "variantIndex".length
    );
    expectToken(
      tokens,
      offsetOf(source, "itemIndex", 1),
      "variable",
      readonlyFlag,
      "itemIndex".length
    );
    expectToken(
      tokens,
      offsetOf(source, "variantIndex", 1),
      "variable",
      readonlyFlag,
      "variantIndex".length
    );
  });

  it("classifies computed resource-key references and texture literals", () => {
    const source = [
      "let slot = \"particle\"",
      "model block semantic_fields {",
      "  textures { [slot]: #all }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);
    const tokens = getRsglSemanticTokens(bindRsglModule(module));

    expectToken(
      tokens,
      offsetOf(source, "slot"),
      "variable",
      declaration | readonlyFlag,
      "slot".length
    );
    expectToken(
      tokens,
      offsetOf(source, "slot", 1),
      "variable",
      readonlyFlag,
      "slot".length
    );
    expectToken(
      tokens,
      offsetOf(source, "all"),
      "variable",
      0,
      "all".length
    );
  });

  it("classifies recursive item-model option fields without overriding DSL keywords", () => {
    const itemSource = [
      "template choose(fallbackModel: ModelId) -> item_model {",
      "  first_match {",
      "    when property minecraft:component",
      "      component \"minecraft:enchantments\"",
      "      predicate \"contains\"",
      "      value [{ id: minecraft:channeling }] =>",
      "      range property minecraft:damage scale 2 normalize true {",
      "        entry 0 => empty {}",
      "        frames [1] model fallbackModel",
      "        fallback selected_item {}",
      "      } with { transformation: { translation: [0, 0, 0] } }",
      "    fallback fallbackModel",
      "  }",
      "}"
    ].join("\n");
    const itemModule = parseRsgl(itemSource);
    assert.deepStrictEqual(itemModule.diagnostics, []);
    const itemTokens = getRsglSemanticTokens(bindRsglModule(itemModule));

    for (const [needle, length] of [
      ["component \"minecraft:enchantments\"", "component".length],
      ["predicate \"contains\"", "predicate".length],
      ["value [{", "value".length],
      ["scale 2", "scale".length],
      ["normalize true", "normalize".length],
      ["id: minecraft:channeling", "id".length],
      ["transformation:", "transformation".length],
      ["translation:", "translation".length]
    ] as const) {
      expectToken(itemTokens, offsetOf(itemSource, needle), "property", 0, length);
    }

    expectToken(
      itemTokens,
      offsetOf(itemSource, "fallbackModel"),
      "parameter",
      declaration,
      "fallbackModel".length
    );
    expectToken(
      itemTokens,
      offsetOf(itemSource, "fallbackModel", 1),
      "parameter",
      0,
      "fallbackModel".length
    );
    expectToken(
      itemTokens,
      offsetOf(itemSource, "fallbackModel", 2),
      "parameter",
      0,
      "fallbackModel".length
    );

    const keywordOffsets = [
      offsetOf(itemSource, "item_model"),
      offsetOf(itemSource, "first_match"),
      offsetOf(itemSource, "when property"),
      offsetOf(itemSource, "when property") + "when ".length,
      offsetOf(itemSource, "entry 0"),
      offsetOf(itemSource, "empty {}"),
      offsetOf(itemSource, "frames [1]"),
      offsetOf(itemSource, "] model ") + 2,
      offsetOf(itemSource, "fallback selected_item"),
      offsetOf(itemSource, "selected_item"),
      offsetOf(itemSource, "} with {") + 2
    ];
    assert.ok(keywordOffsets.every(start => !itemTokens.some(token => token.start === start)));
  });

  it("returns sorted, non-overlapping tokens", () => {
    let lastEnd = -1;
    for (const token of tokens) {
      assert.ok(token.length > 0, "token lengths must be positive");
      assert.ok(token.start >= lastEnd, `token at ${token.start} overlaps the previous token`);
      lastEnd = token.start + token.length;
    }
  });

  it("classifies local exports, re-exports, and import aliases in their linked namespaces", () => {
    const root = path.resolve("pack", "module-specifier-tokens");
    const mainFile = path.join(root, "main.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const familiesFile = path.join(root, "families.rsgl");
    const familiesText = [
      "type ShapeFamily = { name: String }",
      "let slabFamilies: List<ShapeFamily> = []",
      "template buildFamily(name: String) {",
      "  let selected = name",
      "}",
      "export {",
      "  ShapeFamily,",
      "  slabFamilies,",
      "  buildFamily",
      "}"
    ].join("\n");
    const barrelText = [
      "export {",
      "  ShapeFamily,",
      "  ShapeFamily as PublicFamily,",
      "  slabFamilies,",
      "  slabFamilies as publicFamilies,",
      "  buildFamily as publicBuilder",
      "} from \"./families.rsgl\""
    ].join("\n");
    const mainText = [
      "import {",
      "  ShapeFamily,",
      "  slabFamilies,",
      "  PublicFamily as Family,",
      "  publicFamilies as families,",
      "  publicBuilder as makeFamily",
      "} from \"./barrel.rsgl\"",
      "let selected: Family = families",
      "use makeFamily(\"stone\")"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainText) },
      { fileName: barrelFile, module: parseRsgl(barrelText) },
      { fileName: familiesFile, module: parseRsgl(familiesText) }
    ]);
    const familiesModel = program.models.find(candidate => candidate.fileName === familiesFile);
    const barrelModel = program.models.find(candidate => candidate.fileName === barrelFile);
    const mainModel = program.models.find(candidate => candidate.fileName === mainFile);
    assert.ok(familiesModel && barrelModel && mainModel, "expected every module to be bound");

    const familiesTokens = getRsglSemanticTokens(familiesModel, program);
    expectToken(
      familiesTokens,
      offsetOf(familiesText, "ShapeFamily", 2),
      "type",
      0,
      "ShapeFamily".length
    );
    expectToken(
      familiesTokens,
      offsetOf(familiesText, "slabFamilies", 1),
      "variable",
      readonlyFlag,
      "slabFamilies".length
    );
    expectToken(
      familiesTokens,
      offsetOf(familiesText, "buildFamily", 1),
      "function",
      0,
      "buildFamily".length
    );

    // A standalone model has no target module for a source re-export. Its
    // cache entry must not suppress the later linked-program classifications.
    const standaloneBarrelTokens = getRsglSemanticTokens(barrelModel);
    assert.ok(!standaloneBarrelTokens.some(token =>
      token.start === offsetOf(barrelText, "PublicFamily")
    ));
    const barrelTokens = getRsglSemanticTokens(barrelModel, program);
    expectToken(barrelTokens, offsetOf(barrelText, "ShapeFamily"), "type", 0, "ShapeFamily".length);
    expectToken(barrelTokens, offsetOf(barrelText, "PublicFamily"), "type", 0, "PublicFamily".length);
    expectToken(barrelTokens, offsetOf(barrelText, "slabFamilies"), "variable", readonlyFlag, "slabFamilies".length);
    expectToken(barrelTokens, offsetOf(barrelText, "publicFamilies"), "variable", readonlyFlag, "publicFamilies".length);
    expectToken(barrelTokens, offsetOf(barrelText, "buildFamily"), "function", 0, "buildFamily".length);
    expectToken(barrelTokens, offsetOf(barrelText, "publicBuilder"), "function", 0, "publicBuilder".length);
    assert.strictEqual(getRsglSemanticTokens(barrelModel), standaloneBarrelTokens);
    assert.strictEqual(getRsglSemanticTokens(barrelModel, program), barrelTokens);

    const mainTokens = getRsglSemanticTokens(mainModel, program);
    expectToken(mainTokens, offsetOf(mainText, "ShapeFamily"), "type", declaration, "ShapeFamily".length);
    expectToken(mainTokens, offsetOf(mainText, "slabFamilies"), "variable", declaration, "slabFamilies".length);
    expectToken(mainTokens, offsetOf(mainText, "PublicFamily"), "type", 0, "PublicFamily".length);
    expectToken(
      mainTokens,
      offsetOf(mainText, "PublicFamily as Family") + "PublicFamily as ".length,
      "type",
      declaration,
      "Family".length
    );
    expectToken(mainTokens, offsetOf(mainText, "publicFamilies"), "variable", 0, "publicFamilies".length);
    expectToken(mainTokens, offsetOf(mainText, "families"), "variable", declaration, "families".length);
    expectToken(mainTokens, offsetOf(mainText, "publicBuilder"), "function", 0, "publicBuilder".length);
    expectToken(mainTokens, offsetOf(mainText, "makeFamily"), "function", declaration, "makeFamily".length);
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
          "template cube(id: TextureId, texture: TextureId = id) {",
          "  model block id {",
          "    parent minecraft:block/cube_all",
          "    textures { all: texture }",
          "  }",
          "}",
          "export { cube }"
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
      "blockstate variants custom_slab {",
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
          "  case { type: \"bottom\" } => bottom",
          "  case { type: \"top\" } => top",
          "  case { type: \"double\" } => double",
          "}",
          "export { slab }"
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
    assert.deepStrictEqual(rsglSemanticTokenTypes, [
      "namespace", "type", "function", "variable", "parameter", "property"
    ]);
    assert.deepStrictEqual(rsglSemanticTokenModifiers, [
      "declaration", "readonly", "defaultLibrary"
    ]);
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
      scope: { kind: "module", symbols: new Map(), typeAliases: new Map() },
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
      diagnostics: [],
      resolvedExpectedTypes: new Map()
    };

    assert.deepStrictEqual(getRsglSemanticTokens(model), [
      { start: 10, length: 4, tokenType: tokenType("variable"), tokenModifiers: readonlyFlag | declaration },
      { start: 14, length: 3, tokenType: tokenType("variable"), tokenModifiers: readonlyFlag }
    ]);
  });
});
