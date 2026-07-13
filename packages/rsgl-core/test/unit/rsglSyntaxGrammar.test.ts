import * as assert from "node:assert";
import {
  type GrammarPattern,
  type GrammarTokenization,
  type RsglGrammar,
  readGrammar,
  readGrammarText,
  repositoryPatterns,
  tokenizeGrammar
} from "./helpers/textMateGrammar";

describe("RSGL TextMate grammar", () => {
  it("highlights base and merge vocabulary without retaining removed syntax", () => {
    const grammarText = readGrammarText();
    const grammar = JSON.parse(grammarText) as RsglGrammar;
    const controlKeywords = matchRegex(namedPattern(grammar, "keywords", "keyword.control.rsgl"));

    for (const keyword of ["base", "merge", "deep", "strict", "upsert", "append"]) {
      assert.match(keyword, controlKeywords, `Expected '${keyword}' to use keyword.control.rsgl.`);
    }
    for (const removed of ["raw_json", "raw_json_file", "override"]) {
      assert.strictEqual(grammarText.includes(removed), false, `Removed syntax '${removed}' remains in the grammar.`);
    }
  });

  it("highlights only the public template output dialects", () => {
    const grammar = readGrammar();
    const source = [
      "template modelBody() -> model {}",
      "template states() -> variants {}",
      "template parts() -> multipart {}"
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    expectScope(tokenization, source, "->", "keyword.operator.template-output.rsgl", 0);
    expectScope(tokenization, source, "->", "keyword.operator.template-output.rsgl", 1);
    expectScope(tokenization, source, "->", "keyword.operator.template-output.rsgl", 2);
    expectScope(tokenization, source, "model", "storage.type.template-output.rsgl", 1);
    expectScope(tokenization, source, "variants", "storage.type.template-output.rsgl");
    expectScope(tokenization, source, "multipart", "storage.type.template-output.rsgl");
    const grammarText = readGrammarText();
    assert.doesNotMatch(grammarText, /(?<!shader_)\bfragment\b/);
    assert.doesNotMatch(grammarText, /\bfn\b/);
  });

  it("highlights blockstate header modes and scopes legacy syntax as deprecated", () => {
    const grammar = readGrammar();
    const source = [
      "blockstate variants stairs {",
      "  { facing: north }: minecraft:block/stairs",
      "}",
      "blockstate multipart wall {",
      "  apply minecraft:block/wall",
      "}",
      "blockstate stairs {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stairs",
      "  }",
      "}"
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    expectScope(tokenization, source, "blockstate", "storage.type.rsgl", 0);
    expectScope(tokenization, source, "blockstate", "storage.type.rsgl", 1);
    expectScope(tokenization, source, "variants", "storage.modifier.blockstate-mode.rsgl", 0);
    expectScope(tokenization, source, "multipart", "storage.modifier.blockstate-mode.rsgl", 0);
    expectNoScope(tokenization, source, "variants", "invalid.deprecated.blockstate-wrapper.rsgl", 0);
    expectScope(tokenization, source, "variants", "invalid.deprecated.blockstate-wrapper.rsgl", 1);
    expectScope(tokenization, source, "[facing=north]", "invalid.deprecated.blockstate-selector.rsgl");
    expectScope(tokenization, source, "->", "invalid.deprecated.blockstate-arrow.rsgl");
    expectScope(tokenization, source, "@", "invalid.deprecated.blockstate-model-apply.rsgl");
  });

  it("limits legacy wrapper scopes to blockstate declaration bodies", () => {
    const grammar = readGrammar();
    const source = [
      "model block presentation {",
      "  variants {",
      "    model: minecraft:block/stone",
      "  }",
      "  multipart {",
      "    model: minecraft:block/stone",
      "  }",
      "}",
      "json metadata {",
      "  variants {",
      "    enabled: true",
      "  }",
      "  multipart {",
      "    enabled: true",
      "  }",
      "}",
      "blockstate stone {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stone",
      "  }",
      "}"
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    expectNoScope(tokenization, source, "variants", "invalid.deprecated.blockstate-wrapper.rsgl", 0);
    expectNoScope(tokenization, source, "multipart", "invalid.deprecated.blockstate-wrapper.rsgl", 0);
    expectNoScope(tokenization, source, "variants", "invalid.deprecated.blockstate-wrapper.rsgl", 1);
    expectNoScope(tokenization, source, "multipart", "invalid.deprecated.blockstate-wrapper.rsgl", 1);
    expectScope(tokenization, source, "variants", "invalid.deprecated.blockstate-wrapper.rsgl", 2);
  });

  it("keeps valid, commented, and malformed extern patterns out of block-comment leakage", () => {
    const grammar = readGrammar();
    const externContext = repositoryPatterns(grammar, "externDeclarations").find(pattern =>
      pattern.beginCaptures?.["1"]?.name === "storage.type.rsgl"
    );
    assert.ok(externContext?.begin, "Expected an extern declaration context.");
    assert.ok(externContext.end?.startsWith("$|"), "Extern highlighting must end with the source line or expression syntax.");

    const globPattern = namedPattern(grammar, "externResourcePatterns", "entity.name.resource-pattern.rsgl");
    const exactGlob = exactRegex(globPattern);
    for (const resourcePattern of [
      "minecraft:block/stair/**",
      "block/*",
      "*:block/**",
      "minecraft:block/*/foo/**",
      "minecraft:*/foo/*",
      "block/**/nested/*",
      "**",
      "*:shared"
    ]) {
      assert.match(resourcePattern, exactGlob, `Expected complete extern glob '${resourcePattern}'.`);
      const source = `extern! custom model ${resourcePattern}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScope(tokenization, source, resourcePattern, "entity.name.resource-pattern.rsgl");
      expectScopeAcross(tokenization, source, "extern!", "storage.type.rsgl");
      expectNoScope(tokenization, source, "extern!", "keyword.operator.rsgl", 0, "extern".length);
      expectScope(tokenization, source, "custom", "storage.modifier.rsgl");
      expectScope(tokenization, source, "model", "storage.type.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    for (const header of [
      "extern /* source comment */ custom model block/**",
      "extern custom /* kind comment */ model block/**"
    ]) {
      const source = `${header}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScope(tokenization, source, "comment", "comment.block.rsgl");
      expectScope(tokenization, source, "block/**", "entity.name.resource-pattern.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    for (const header of [
      "extern /* source\ncomment */ custom model block/**",
      "extern custom /* kind\ncomment */ model block/**"
    ]) {
      const source = `${header}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScope(tokenization, source, "comment", "comment.block.rsgl");
      expectScope(tokenization, source, "block/**", "entity.name.resource-pattern.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    for (const [header, typo, scope] of [
      ["extern custom modle block/**", "modle", "invalid.illegal.extern-kind.rsgl"],
      ["extern customs model block/**", "customs", "invalid.illegal.extern-source.rsgl"],
      ["extern custom modelx block/**", "modelx", "invalid.illegal.extern-kind.rsgl"]
    ] as const) {
      const source = `${header}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScope(tokenization, source, typo, scope);
      expectScope(tokenization, source, "block/**", "entity.name.resource-pattern.rsgl");
      expectNoScope(tokenization, source, "block/**", "comment.block.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    for (const header of [
      "extern custom model/*before*/block/**",
      "extern custom model block/**/*tail*/",
      "extern custom model block/**//tail",
      "extern custom model block/stone//tail"
    ]) {
      const source = `${header}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScope(tokenization, source, "block", "entity.name.resource-pattern.rsgl");
      expectScope(tokenization, source, header.includes("before") ? "before" : "tail", header.includes("//tail")
        ? "comment.line.double-slash.rsgl"
        : "comment.block.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    const headerNamedPatterns = "extern custom model custom, model";
    const headerNamedTokenization = tokenizeGrammar(grammar, headerNamedPatterns);
    expectScope(headerNamedTokenization, headerNamedPatterns, "custom", "storage.modifier.rsgl", 0);
    expectScope(headerNamedTokenization, headerNamedPatterns, "model", "storage.type.rsgl", 0);
    expectScope(headerNamedTokenization, headerNamedPatterns, "custom", "entity.name.resource-pattern.rsgl", 1);
    expectScope(headerNamedTokenization, headerNamedPatterns, "model", "entity.name.resource-pattern.rsgl", 1);

    for (const invalidPattern of [
      "minecraft:block/**suffix",
      "minecraft:block/***",
      "**:block",
      "minecraft:block/a*b",
      "minecraft:block/.",
      "minecraft:block/../stone"
    ]) {
      assert.doesNotMatch(invalidPattern, exactGlob, `Invalid extern glob '${invalidPattern}' was highlighted as valid.`);
      const source = `extern custom model ${invalidPattern}\nlet after = true`;
      const tokenization = tokenizeGrammar(grammar, source);
      expectScopeAcross(tokenization, source, invalidPattern, "invalid.illegal.resource-pattern.rsgl");
      expectNoScopeAcross(tokenization, source, invalidPattern, "comment.block.rsgl");
      expectRootScope(tokenization, source, "after");
    }

    const comments = [
      "extern custom model /* before */ block/**",
      "extern custom model block/** /* after */"
    ].join("\n");
    const commentTokenization = tokenizeGrammar(grammar, comments);
    expectScope(commentTokenization, comments, "before", "comment.block.rsgl");
    expectScope(commentTokenization, comments, "after", "comment.block.rsgl");
    expectScope(commentTokenization, comments, "block/**", "entity.name.resource-pattern.rsgl", 0);
    expectScope(commentTokenization, comments, "block/**", "entity.name.resource-pattern.rsgl", 1);

    const externVar = "model block example {\n  extern var #front, #back\n  extern var /* multi\n  line */ #side\n}";
    const externVarTokenization = tokenizeGrammar(grammar, externVar);
    expectScope(externVarTokenization, externVar, "var", "storage.modifier.rsgl");
    expectScope(externVarTokenization, externVar, "#front", "variable.other.texture.rsgl");
    expectScope(externVarTokenization, externVar, "#side", "variable.other.texture.rsgl");

    const nonDeclarations = [
      "let extern = \"foo\"",
      "let selected = extern",
      "let entry = { extern: \"bar\" }",
      "let values = [",
      "  extern + 42,",
      "  extern.member,",
      "  extern(42)",
      "]",
      "extern custom",
      "extern custom model",
      "extern var"
    ].join("\n");
    const nonDeclarationTokenization = tokenizeGrammar(grammar, nonDeclarations);
    expectScope(nonDeclarationTokenization, nonDeclarations, "foo", "string.quoted.double.rsgl");
    expectScope(nonDeclarationTokenization, nonDeclarations, "bar", "string.quoted.double.rsgl");
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "foo", "entity.name.resource-pattern.rsgl");
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "42", "entity.name.resource-pattern.rsgl", 0);
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "42", "entity.name.resource-pattern.rsgl", 1);
    expectScope(nonDeclarationTokenization, nonDeclarations, ".member", "meta.member-name.rsgl", 0, 1);
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "custom", "entity.name.resource-pattern.rsgl");
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "model", "entity.name.resource-pattern.rsgl");
    expectNoScope(nonDeclarationTokenization, nonDeclarations, "var", "entity.name.resource-pattern.rsgl");
    expectScope(nonDeclarationTokenization, nonDeclarations, "extern:", "meta.object-key.rsgl");
    expectScope(nonDeclarationTokenization, nonDeclarations, "custom", "storage.modifier.rsgl");
    expectScope(nonDeclarationTokenization, nonDeclarations, "model", "storage.type.rsgl");
    expectScope(nonDeclarationTokenization, nonDeclarations, "var", "storage.modifier.rsgl");

    const commentedObjectKey = "table values {\n  extern /* multi\n  line */: \"value\"\n}";
    const commentedObjectKeyTokenization = tokenizeGrammar(grammar, commentedObjectKey);
    expectScope(commentedObjectKeyTokenization, commentedObjectKey, "multi", "comment.block.rsgl");
    expectScope(commentedObjectKeyTokenization, commentedObjectKey, "value", "string.quoted.double.rsgl", 1);
    expectNoScope(commentedObjectKeyTokenization, commentedObjectKey, "value", "entity.name.resource-pattern.rsgl", 1);

    const multilineComment = "/* first\nsecond */\nlet after = true";
    const multilineTokenization = tokenizeGrammar(grammar, multilineComment);
    expectScope(multilineTokenization, multilineComment, "first", "comment.block.rsgl");
    expectScope(multilineTokenization, multilineComment, "second", "comment.block.rsgl");
    expectRootScope(multilineTokenization, multilineComment, "after");
  });

  it("distinguishes object keys and members from DSL declarations", () => {
    const grammar = readGrammar();
    const source = [
      "let entries = [{ dir: \"kelp\", parent: block/foo, north: 0 }]",
      "template sample(parent: ModelId) {",
      "  model block demo {",
      "    parent parent",
      "  }",
      "}",
      "blockstate multipart demo {",
      "  apply { model: block/foo }",
      "}",
      "let named = call(base: block/foo, pad: 2)",
      "let member = entry.model",
      "let ternary = condition ? true : false",
      "let moduleKeys = { import: 1, export: 2 }"
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    for (const key of ["parent:", "north:", "model:", "base:", "pad:"]) {
      expectScope(tokenization, source, key, "meta.object-key.rsgl");
    }
    expectScope(tokenization, source, ".model", "meta.member-name.rsgl", 0, 1);
    expectScope(tokenization, source, "parent parent", "variable.other.property.rsgl");
    expectScope(tokenization, source, "true : false", "constant.language.rsgl");
    expectNoScope(tokenization, source, "parent:", "variable.other.property.rsgl");
    expectNoScope(tokenization, source, "model:", "storage.type.rsgl");
    expectScope(tokenization, source, "import:", "meta.object-key.rsgl");
    expectScope(tokenization, source, "export:", "meta.object-key.rsgl");
    expectNoScope(tokenization, source, "import:", "keyword.control.rsgl");
    expectNoScope(tokenization, source, "export:", "keyword.control.rsgl");
  });

  it("highlights compound declarations and parser-recognized structural vocabulary", () => {
    const grammar = readGrammar();
    const source = [
      "target java format [50, 0]",
      "overlay \"future\" format [90, 0]..[91, 0] {",
      "  model block stone {}",
      "  model item stick {}",
      "}",
      "let pathValue = block/foo",
      "let blockKey = { block: 1 }",
      "blockstate variants demo { {}: random [minecraft:block/stone] }",
      "paletted_permutations {",
      "  palette_key minecraft:trims/color_palettes/trim_palette",
      "  permutations palettes",
      "}",
      ...["formats", "block", "directory", "paletted_permutations", "palette_key", "permutations", "layer", "models", "gui", "scaling", "layers"]
        .map(keyword => `${keyword} {}`)
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    expectScope(tokenization, source, "target", "storage.type.rsgl");
    expectScope(tokenization, source, "java", "storage.modifier.rsgl");
    expectScope(tokenization, source, "format", "storage.modifier.rsgl", 0);
    expectScope(tokenization, source, "overlay", "storage.type.rsgl");
    expectScope(tokenization, source, "format", "keyword.control.rsgl", 1);
    expectScope(tokenization, source, "model block", "storage.modifier.rsgl", 0, "model ".length);
    expectScope(tokenization, source, "model item", "storage.modifier.rsgl", 0, "model ".length);
    expectScope(tokenization, source, "random", "keyword.control.rsgl");
    for (const structural of ["formats", "block", "directory", "paletted_permutations", "palette_key", "permutations", "layer", "models", "gui", "scaling", "layers"]) {
      expectScope(tokenization, source, `${structural} {`, "keyword.control.rsgl");
    }
    expectNoScope(tokenization, source, "block/foo", "storage.modifier.rsgl");
    expectScope(tokenization, source, "block:", "meta.object-key.rsgl");
  });

  it("distinguishes import-source and model-geometry from scopes", () => {
    const grammar = readGrammar();
    const source = [
      "import geometry from \"./geometry.rsgl\"",
      "import alternateGeometry",
      "from \"./alternate-geometry.rsgl\"",
      "export { geometry }",
      "from /* shared",
      "  comment */ \"./geometry.rsgl\"",
      "let metadata = {",
      "  from: \"source\"",
      "}",
      "json metadata {",
      "  from \"source\"",
      "}",
      "model block sample {",
      "  element from [0.8, 0, 8] to [15.2, 16, 8] {",
      "    all texture \"#all\"",
      "  }",
      "}"
    ].join("\n");
    const tokenization = tokenizeGrammar(grammar, source);

    for (let occurrence = 0; occurrence < 3; occurrence++) {
      expectScope(tokenization, source, "from", "keyword.control.rsgl", occurrence);
      expectNoScope(tokenization, source, "from", "variable.other.property.rsgl", occurrence);
    }
    expectScope(tokenization, source, "from", "meta.object-key.rsgl", 3);
    expectNoScope(tokenization, source, "from", "keyword.control.rsgl", 3);
    expectScope(tokenization, source, "from", "variable.other.property.rsgl", 4);
    expectNoScope(tokenization, source, "from", "keyword.control.rsgl", 4);
    expectScope(tokenization, source, "from", "variable.other.property.rsgl", 5);
    expectNoScope(tokenization, source, "from", "keyword.control.rsgl", 5);
    expectScope(tokenization, source, "to", "variable.other.property.rsgl");
  });

  it("matches complete resource locations at punctuation-valid boundaries", () => {
    const grammar = readGrammar();
    const resourceRegex = matchRegex(namedPattern(
      grammar,
      "resourceLocations",
      "entity.name.resource-location.rsgl"
    ));
    for (const resource of [
      "minecraft:block/stone",
      ".hidden:path",
      "-mod:path",
      "minecraft:path-",
      "minecraft:path."
    ]) {
      const match = resourceRegex.exec(resource);
      assert.ok(match, `Expected resource location '${resource}'.`);
      assert.strictEqual(match.index, 0);
      assert.strictEqual(match[0], resource);
    }
    for (const invalid of ["Xminecraft:path", "minecraft:path*", "minecraft:path:tail"]) {
      assert.doesNotMatch(invalid, resourceRegex, `Resource rule partially matched '${invalid}'.`);
    }
  });
});

function namedPattern(grammar: RsglGrammar, repository: string, scope: string): GrammarPattern {
  const pattern = repositoryPatterns(grammar, repository).find(candidate => candidate.name === scope);
  assert.ok(pattern?.match, `Expected '${scope}' in grammar repository '${repository}'.`);
  return pattern;
}

function matchRegex(pattern: GrammarPattern): RegExp {
  assert.ok(pattern.match, "Expected a match-based grammar pattern.");
  return new RegExp(pattern.match);
}

function exactRegex(pattern: GrammarPattern): RegExp {
  assert.ok(pattern.match, "Expected a match-based grammar pattern.");
  return new RegExp(`^(?:${pattern.match})$`);
}

function expectScope(
  tokenization: GrammarTokenization,
  source: string,
  needle: string,
  scope: string,
  occurrence = 0,
  withinNeedle = 0
): void {
  const offset = offsetOf(source, needle, occurrence) + withinNeedle;
  assert.ok(
    tokenization.scopesAt(offset).includes(scope),
    `Expected '${needle}' occurrence ${occurrence} at ${offset} to include scope '${scope}', got ${tokenization.scopesAt(offset).join(", ")}.`
  );
}

function expectNoScope(
  tokenization: GrammarTokenization,
  source: string,
  needle: string,
  scope: string,
  occurrence = 0,
  withinNeedle = 0
): void {
  const offset = offsetOf(source, needle, occurrence) + withinNeedle;
  assert.ok(
    !tokenization.scopesAt(offset).includes(scope),
    `Expected '${needle}' occurrence ${occurrence} at ${offset} not to include scope '${scope}'.`
  );
}

function expectScopeAcross(
  tokenization: GrammarTokenization,
  source: string,
  needle: string,
  scope: string,
  occurrence = 0
): void {
  for (let offset = 0; offset < needle.length; offset++) {
    expectScope(tokenization, source, needle, scope, occurrence, offset);
  }
}

function expectNoScopeAcross(
  tokenization: GrammarTokenization,
  source: string,
  needle: string,
  scope: string,
  occurrence = 0
): void {
  for (let offset = 0; offset < needle.length; offset++) {
    expectNoScope(tokenization, source, needle, scope, occurrence, offset);
  }
}

function expectRootScope(
  tokenization: GrammarTokenization,
  source: string,
  needle: string,
  occurrence = 0
): void {
  const offset = offsetOf(source, needle, occurrence);
  assert.deepStrictEqual(
    tokenization.scopesAt(offset),
    [],
    `Expected '${needle}' occurrence ${occurrence} at ${offset} to be in the root context.`
  );
}

function offsetOf(source: string, needle: string, occurrence = 0): number {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = source.indexOf(needle, offset + 1);
    assert.ok(offset >= 0, `Expected occurrence ${index} of '${needle}'.`);
  }
  return offset;
}
