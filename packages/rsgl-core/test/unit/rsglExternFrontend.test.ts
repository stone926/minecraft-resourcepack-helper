import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
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

  it("rejects legacy declarations, separated bang modifiers, and invalid glob namespaces", () => {
    const legacy = parseRsgl("extern model(id: minecraft:block/stone)");
    assert.ok(legacy.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidExternSource"));

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

  it("highlights the new sourced extern forms and model texture variables", () => {
    const grammar = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "extensions", "vscode-rsgl", "syntaxes", "rsgl.tmLanguage.json"),
      "utf8"
    )) as {
      repository?: {
        keywords?: { patterns?: GrammarPattern[] };
        properties?: { patterns?: GrammarPattern[] };
      };
    };
    const keywordPatterns = grammar.repository?.keywords?.patterns ?? [];
    const externPattern = keywordPatterns.find(pattern =>
      pattern.captures?.["6"]?.name === "storage.type.rsgl"
      && pattern.match?.includes("custom|vanilla")
    );
    assert.ok(externPattern?.match, "Expected a sourced extern TextMate rule.");
    const externRegex = new RegExp(externPattern.match);
    for (const kind of [
      "model", "blockstate", "item", "texture", "texture_directory",
      "sound", "font", "font_file", "shader_vertex", "shader_fragment"
    ]) {
      assert.match(`extern! vanilla ${kind}`, externRegex);
    }
    assert.doesNotMatch("extern model", externRegex);

    const externVarPattern = keywordPatterns.find(pattern => pattern.match?.includes("(var)"));
    assert.ok(externVarPattern?.match);
    assert.match("extern var", new RegExp(externVarPattern.match));
    assert.match("#front", new RegExp(
      grammar.repository?.properties?.patterns?.find(pattern =>
        pattern.name === "variable.other.texture.rsgl"
      )?.match ?? "(?!)"
    ));
  });
});

interface GrammarPattern {
  name?: string;
  match?: string;
  captures?: Record<string, { name?: string }>;
}
