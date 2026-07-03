import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRsglCompletionCandidates } from "../../rsgl/completionData";
import { formatRsglText } from "../../rsgl/formatterCore";
import { lexRsgl, parseRsgl } from "../../rsgl/parser";

describe("RSGL language", () => {
  it("contributes the rsgl language and bundled editor assets", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      activationEvents?: string[];
      contributes?: {
        languages?: Array<{ id?: string; extensions?: string[]; configuration?: string }>;
        grammars?: Array<{ language?: string; path?: string; scopeName?: string }>;
      };
    };

    assert.ok(packageJson.activationEvents?.includes("onLanguage:rsgl"));
    const language = packageJson.contributes?.languages?.find(entry => entry.id === "rsgl");
    assert.ok(language);
    assert.ok(language.extensions?.includes(".rsgl"));
    assert.ok(language.configuration);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(process.cwd(), language.configuration!), "utf8")));

    const grammar = packageJson.contributes?.grammars?.find(entry => entry.language === "rsgl");
    assert.strictEqual(grammar?.scopeName, "source.rsgl");
    assert.ok(grammar.path);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(process.cwd(), grammar.path!), "utf8")));
  });

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

  it("parses a representative experimental module without diagnostics", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "namespace minecraft",
      "import \"./tables/woods.rsgl\"",
      "model block acacia_planks {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    all: minecraft:block/acacia_planks",
      "  }",
      "}",
      "stairs acacia_stairs"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(module.statements.length, 5);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "TargetDecl",
      "NamespaceDecl",
      "ImportDecl",
      "ResourceDecl",
      "SugarDecl"
    ]);

    const model = module.statements[3];
    assert.strictEqual(model.kind, "ResourceDecl");
    assert.strictEqual(model.resourceKind, "model");
    assert.strictEqual(model.subtype?.text, "block");
    assert.strictEqual(model.body.statements[0].kind, "PropertyStmt");
  });

  it("builds expression ASTs for ranges, calls, members, conditionals, and template interpolation", () => {
    const module = parseRsgl([
      "let frames = seq(`minecraft:item/clock_${pad(index, 2)}`)",
      "let powered = state.powered ? 1..4 : [0, 1]"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const frames = module.statements[0];
    assert.strictEqual(frames.kind, "LetDecl");
    assert.strictEqual(frames.value.kind, "CallExpr");
    const template = frames.value.args[0].value;
    assert.strictEqual(template.kind, "TemplateStringExpr");
    assert.strictEqual(template.parts.some(part => part.kind === "expression" && part.expression.kind === "CallExpr"), true);

    const powered = module.statements[1];
    assert.strictEqual(powered.kind, "LetDecl");
    assert.strictEqual(powered.value.kind, "ConditionalExpr");
    assert.strictEqual(powered.value.condition.kind, "MemberExpr");
    assert.strictEqual(powered.value.whenTrue.kind, "RangeExpr");
    assert.strictEqual(powered.value.whenFalse.kind, "ListExpr");
  });

  it("keeps state key and model apply sugar as expression AST nodes", () => {
    const module = parseRsgl([
      "blockstate minecraft:example {",
      "  variants {",
      "    [facing=west half=bottom] -> @block/example y=90 uvlock",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const blockstate = module.statements[0];
    assert.strictEqual(blockstate.kind, "ResourceDecl");
    const variants = blockstate.body.statements[0];
    assert.strictEqual(variants.kind, "VariantsSection");
    assert.strictEqual(variants.entries[0].state.kind, "StateKeySugar");
    assert.strictEqual(variants.entries[0].value.kind, "ModelApplySugar");
    assert.strictEqual(variants.entries[0].value.properties.length, 2);
  });

  it("parses multipart entries with structured when/apply nodes", () => {
    const module = parseRsgl([
      "blockstate minecraft:oak_fence {",
      "  multipart {",
      "    apply { model: minecraft:block/oak_fence_post }",
      "    when { north: true } apply { model: minecraft:block/oak_fence_side }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const blockstate = module.statements[0];
    assert.strictEqual(blockstate.kind, "ResourceDecl");
    const multipart = blockstate.body.statements[0];
    assert.strictEqual(multipart.kind, "MultipartSection");
    assert.strictEqual(multipart.entries.length, 2);
    assert.strictEqual(multipart.entries[0].when, undefined);
    assert.strictEqual(multipart.entries[1].when?.kind, "ObjectExpr");
    assert.strictEqual(multipart.entries[1].apply.kind, "ObjectExpr");
  });

  it("recovers from syntax errors and reports actionable diagnostics", () => {
    const module = parseRsgl([
      "target java format [88, 0]",
      "blockstate minecraft:example {",
      "  variants {",
      "    {} -> { model: minecraft:block/example }",
      "  }",
      "  multipart {",
      "    apply { model: minecraft:block/example }",
      "  }",
      "}",
      "model block broken {",
      "  parent",
      "  textures { all: minecraft:block/example }"
    ].join("\n"));

    const codes = module.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.blockstateSectionConflict"));
    assert.ok(codes.includes("rsgl.expectedPropertyValue"));
    assert.ok(codes.includes("rsgl.expectedClosingBrace"));
  });

  it("provides top-level and block-aware completion candidates", () => {
    const topLevel = getRsglCompletionCandidates("", 0);
    assert.ok(topLevel.some(candidate => candidate.label === "target"));
    assert.ok(topLevel.some(candidate => candidate.label === "cubeAll"));

    const inBlock = getRsglCompletionCandidates("model block stone {\n  ", "model block stone {\n  ".length);
    assert.ok(inBlock.some(candidate => candidate.label === "textures"));
    assert.ok(inBlock.some(candidate => candidate.label === "raw_json"));
  });

  it("formats indentation without changing source content inside strings", () => {
    const formatted = formatRsglText([
      "model block stone {",
      "parent minecraft:block/cube_all  ",
      "textures {",
      "all: `minecraft:block/${name}`",
      "}",
      "}"
    ].join("\n"));

    assert.strictEqual(formatted, [
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    all: `minecraft:block/${name}`",
      "  }",
      "}"
    ].join("\n"));
  });
});
