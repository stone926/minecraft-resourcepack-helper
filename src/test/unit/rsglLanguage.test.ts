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
