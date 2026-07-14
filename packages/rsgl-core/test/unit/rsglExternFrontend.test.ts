import * as assert from "node:assert";
import { getRsglCompletionCandidates } from "../../src/completionData";
import { lexRsgl, parseRsgl, type ExternDeclNode } from "../../src/parser";

describe("RSGL extern language frontend", () => {
  it("lexes extern modifiers, wildcards, and texture variables without invalid characters", () => {
    const result = lexRsgl([
      "extern! custom texture minecraft:block/**",
      "model block template {",
      "  extern var #front, #back",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.tokens.find(token => token.text === "custom")?.kind, "keyword");
    assert.strictEqual(result.tokens.find(token => token.text === "var")?.kind, "keyword");
    assert.strictEqual(result.tokens.filter(token => token.text === "#").length, 2);
  });

  it("keeps every legal wildcard segment out of block-comment trivia", () => {
    const source = [
      "extern custom model block/**",
      "extern custom model block/*",
      "extern custom model *:block/**",
      "extern custom model minecraft:block/*/foo/**",
      "extern custom model minecraft:*/foo/*",
      "extern custom model block/**/nested/*",
      "extern custom model block/*, */foo",
      "overlay \"future\" { extern custom model block/** }",
      "let after = true"
    ].join("\n");

    const result = lexRsgl(source);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.tokens.some(token => token.text === "after"), "The lexer swallowed the statement after an extern glob.");

    const module = parseRsgl(source);
    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(
      module.statements
        .filter((statement): statement is ExternDeclNode => statement.kind === "ExternDecl")
        .flatMap(declaration => declaration.patterns.map(pattern => pattern.text)),
      [
        "block/**",
        "block/*",
        "*:block/**",
        "minecraft:block/*/foo/**",
        "minecraft:*/foo/*",
        "block/**/nested/*",
        "block/*",
        "*/foo"
      ]
    );
    assert.strictEqual(module.statements.at(-1)?.kind, "LetDecl");
  });

  it("preserves real block comments around extern declarations and expressions", () => {
    const source = [
      "/* ordinary */",
      "/** documentation */",
      "let sum = 1/* inline */ + 2",
      "extern/* between keyword and bang */! custom model block/stone",
      "extern custom model/**/ block/**",
      "extern custom model /* before pattern */ block/**",
      "extern custom model block /* comma , */",
      "extern custom model block /* semicolon ; */",
      "extern custom model block /* slash // */",
      "extern custom model block /* across",
      "lines */",
      "extern custom model block/*,*/",
      "extern custom model block/*",
      "*/",
      "extern custom model block/stone/**/",
      "extern custom model foo, /* between",
      "lines */ bar/**",
      "extern custom model block/** /* after pattern */",
      "let after = true"
    ].join("\n");

    const result = lexRsgl(source);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(
      result.tokens.flatMap(token => token.leadingTrivia)
        .filter(trivia => trivia.kind === "blockComment")
        .map(trivia => trivia.text),
      [
        "/* ordinary */",
        "/** documentation */",
        "/* inline */",
        "/* between keyword and bang */",
        "/**/",
        "/* before pattern */",
        "/* comma , */",
        "/* semicolon ; */",
        "/* slash // */",
        "/* across\nlines */",
        "/*,*/",
        "/*\n*/",
        "/**/",
        "/* between\nlines */",
        "/* after pattern */"
      ]
    );

    const module = parseRsgl(source);
    assert.strictEqual(
      module.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.externBangMustBeAdjacent").length,
      1
    );
    assert.ok(!module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unterminatedBlockComment"));
    assert.strictEqual(module.statements.at(-1)?.kind, "LetDecl");

    const unterminated = lexRsgl("let value = 1 /* unfinished");
    assert.ok(unterminated.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unterminatedBlockComment"));
  });

  it("keeps malformed extern headers and wildcard-like patterns recoverable", () => {
    const source = [
      "extern custm model block/**",
      "extern custom modle block/**",
      "extern custom model block/**suffix",
      "extern custom model block/***",
      "extern custom model block/* next",
      "let after = true"
    ].join("\n");

    const lexed = lexRsgl(source);
    assert.ok(!lexed.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unterminatedBlockComment"));
    assert.ok(lexed.tokens.some(token => token.text === "after"));

    const module = parseRsgl(source);
    assert.ok(module.diagnostics.length > 0);
    assert.ok(!module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unterminatedBlockComment"));
    assert.strictEqual(module.statements.at(-1)?.kind, "LetDecl");
  });

  it("recovers a large malformed extern wildcard run without swallowing later tokens", () => {
    const source = `extern custom model ${"a/*x/".repeat(4_000)}\nlet after = true`;
    const lexed = lexRsgl(source);

    assert.ok(!lexed.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unterminatedBlockComment"));
    assert.ok(lexed.tokens.some(token => token.text === "after"));
  });

  it("parses sourced extern declarations and keeps pattern text unexpanded", () => {
    const module = parseRsgl([
      "extern custom model minecraft:block/stone",
      "extern custom texture minecraft:item/wood/*, ns:block/**",
      "extern! vanilla texture **",
      "extern vanilla item *:something"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const declarations = module.statements as ExternDeclNode[];
    assert.deepStrictEqual(declarations.map(declaration => ({
      kind: declaration.kind,
      source: declaration.source,
      resourceKind: declaration.resourceKind?.text,
      patterns: declaration.patterns.map(pattern => pattern.text),
      skipExistenceCheck: declaration.skipExistenceCheck
    })), [
      {
        kind: "ExternDecl",
        source: "custom",
        resourceKind: "model",
        patterns: ["minecraft:block/stone"],
        skipExistenceCheck: false
      },
      {
        kind: "ExternDecl",
        source: "custom",
        resourceKind: "texture",
        patterns: ["minecraft:item/wood/*", "ns:block/**"],
        skipExistenceCheck: false
      },
      {
        kind: "ExternDecl",
        source: "vanilla",
        resourceKind: "texture",
        patterns: ["**"],
        skipExistenceCheck: true
      },
      {
        kind: "ExternDecl",
        source: "vanilla",
        resourceKind: "item",
        patterns: ["*:something"],
        skipExistenceCheck: false
      }
    ]);
  });

  it("accepts every frozen extern resource kind in the syntax tree", () => {
    const kinds = [
      "model",
      "blockstate",
      "item",
      "texture",
      "texture_directory",
      "sound",
      "font",
      "font_file",
      "shader_vertex",
      "shader_fragment"
    ];
    const module = parseRsgl(kinds.map(kind => `extern custom ${kind} minecraft:example`).join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(
      module.statements.map(statement => statement.kind === "ExternDecl" ? statement.resourceKind?.text : undefined),
      kinds
    );
  });

  it("rejects separated bang modifiers and invalid glob namespaces", () => {
    const separatedBang = parseRsgl("extern ! custom model minecraft:block/stone");
    assert.ok(separatedBang.diagnostics.some(diagnostic => diagnostic.code === "rsgl.externBangMustBeAdjacent"));

    const recursiveNamespace = parseRsgl("extern custom model **:something");
    assert.ok(recursiveNamespace.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidExternPattern"));
  });

  it("parses extern var only in a model root and rejects its bang modifier", () => {
    const valid = parseRsgl([
      "model block template {",
      "  extern var #front, #back",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(valid.diagnostics, []);
    const model = valid.statements[0];
    assert.strictEqual(model.kind, "ResourceDecl");
    if (model.kind !== "ResourceDecl") {
      throw new Error("Expected model resource declaration.");
    }
    const declaration = model.body.statements[0];
    assert.strictEqual(declaration.kind, "ExternVarStmt");
    if (declaration.kind !== "ExternVarStmt") {
      throw new Error("Expected extern texture-variable declaration.");
    }
    assert.deepStrictEqual(declaration.variables.map(variable => variable.text), ["front", "back"]);

    const invalid = parseRsgl([
      "item example { extern var #item_slot }",
      "model block nested { textures { extern var #nested } }",
      "model block branch { if true { extern var #branch } }",
      "template fragment() { extern var #template_slot }",
      "model block skipped { extern! var #front }"
    ].join("\n"));
    const codes = invalid.diagnostics.map(diagnostic => diagnostic.code);
    assert.strictEqual(codes.filter(code => code === "rsgl.externVarInvalidContext").length, 4);
    assert.strictEqual(codes.filter(code => code === "rsgl.externVarCannotSkipExistenceCheck").length, 1);

    const topLevel = parseRsgl("extern! var #front");
    assert.ok(topLevel.diagnostics.some(diagnostic => diagnostic.code === "rsgl.externVarInvalidContext"));
  });

  it("offers extern var only at model roots", () => {
    const labelsAtEnd = (text: string) => new Set(
      getRsglCompletionCandidates(text, text.length).map(candidate => candidate.label)
    );

    assert.ok(labelsAtEnd("model block template {\n  ").has("extern var"));
    assert.strictEqual(labelsAtEnd("item example {\n  ").has("extern var"), false);
    assert.strictEqual(labelsAtEnd("model block template {\n  textures {\n    ").has("extern var"), false);
    assert.strictEqual(labelsAtEnd("template fragment() {\n  ").has("extern var"), false);
  });

  it("offers sourced and unchecked snippets for every extern kind", () => {
    const candidates = getRsglCompletionCandidates("", 0);
    for (const kind of [
      "model", "blockstate", "item", "texture", "texture_directory",
      "sound", "font", "font_file", "shader_vertex", "shader_fragment"
    ]) {
      const checked = candidates.find(candidate => candidate.label === `extern ${kind}`);
      const unchecked = candidates.find(candidate => candidate.label === `extern! ${kind}`);
      assert.ok(checked?.insertText?.startsWith("extern ${1|custom,vanilla|} "));
      assert.ok(unchecked?.insertText?.startsWith("extern! ${1|custom,vanilla|} "));
      assert.ok(checked?.insertText?.includes(` ${kind} `));
      assert.ok(unchecked?.insertText?.includes(` ${kind} `));
      assert.strictEqual(checked?.insertText?.includes("(id:"), false);
      assert.strictEqual(unchecked?.insertText?.includes("(id:"), false);
    }
  });

});
