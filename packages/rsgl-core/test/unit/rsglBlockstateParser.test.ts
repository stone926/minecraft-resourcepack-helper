import * as assert from "node:assert";
import { walkRsglModule } from "../../src/parser/astTraversal";
import { parseRsgl } from "../../src/parser";

function parseSingleBlockstate(source: string) {
  const module = parseRsgl(source);
  const resource = module.statements[0];
  if (resource?.kind !== "ResourceDecl" || resource.resourceKind !== "blockstate") {
    throw new Error("Expected one blockstate resource declaration.");
  }
  return { module, resource };
}

describe("RSGL blockstate parser", () => {
  it("parses variants and multipart as strong declaration header modes", () => {
    const variantsSource = "blockstate variants variants {}";
    const variants = parseSingleBlockstate(variantsSource);
    assert.deepStrictEqual(variants.module.diagnostics, []);
    assert.strictEqual(variants.resource.blockstateSyntax, "modeHeader");
    assert.strictEqual(variants.resource.mode, "variants");
    assert.strictEqual(variants.resource.modeNode?.text, "variants");
    assert.strictEqual(
      variantsSource.slice(variants.resource.modeNode?.range.start, variants.resource.modeNode?.range.end),
      "variants"
    );
    assert.strictEqual(variants.resource.id.kind, "IdentifierExpr");
    assert.strictEqual(variants.resource.body.kind, "BlockstateVariantsRootBody");

    const multipart = parseSingleBlockstate("blockstate multipart multipart {}");
    assert.deepStrictEqual(multipart.module.diagnostics, []);
    assert.strictEqual(multipart.resource.blockstateSyntax, "modeHeader");
    assert.strictEqual(multipart.resource.mode, "multipart");
    assert.strictEqual(multipart.resource.modeNode?.text, "multipart");
    assert.strictEqual(multipart.resource.body.kind, "BlockstateMultipartRootBody");
  });

  it("preserves missing and unknown mode declarations as legacy recovery AST", () => {
    const missing = parseSingleBlockstate("blockstate stairs {}");
    assert.deepStrictEqual(missing.module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.blockstateModeRequired"
    ]);
    assert.strictEqual(missing.resource.blockstateSyntax, "legacyMissingMode");
    assert.strictEqual(missing.resource.mode, null);
    assert.strictEqual(missing.resource.body.kind, "LegacyBlockstateRootBody");

    const unknown = parseSingleBlockstate("blockstate variant stairs {}");
    assert.deepStrictEqual(unknown.module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unknownBlockstateMode"
    ]);
    assert.strictEqual(unknown.resource.blockstateSyntax, "invalidMode");
    assert.strictEqual(unknown.resource.mode, null);
    assert.strictEqual(unknown.resource.modeNode?.text, "variant");
    assert.strictEqual(unknown.resource.body.kind, "LegacyBlockstateRootBody");
  });

  it("keeps expression-shaped legacy resource ids intact while retaining unknown-mode recovery", () => {
    const cases = [
      "blockstate type == \"nest\" ? \"bee_nest\" : \"beehive\" {}",
      "blockstate entry.id {}",
      "blockstate ids[index] {}",
      "blockstate build_id(type) {}"
    ];
    for (const source of cases) {
      const parsed = parseSingleBlockstate(source);
      assert.strictEqual(parsed.resource.blockstateSyntax, "legacyMissingMode", source);
      assert.deepStrictEqual(parsed.module.diagnostics.map(diagnostic => diagnostic.code), [
        "rsgl.blockstateModeRequired"
      ], source);
    }

    const unknown = parseSingleBlockstate("blockstate typo resource_id {}");
    assert.strictEqual(unknown.resource.blockstateSyntax, "invalidMode");
    assert.deepStrictEqual(unknown.module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unknownBlockstateMode"
    ]);
  });

  it("retains typed variants roots through nested for and if bodies", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants nested {",
      "  base \"./base.json\"",
      "  merge deep { variants: patch }",
      "  for value in values {",
      "    base \"./nested.json\"",
      "    merge { variants: value }",
      "    { key: value }: minecraft:block/value",
      "  }",
      "  if enabled {",
      "    merge { variants: enabledPatch }",
      "  } else {",
      "    { key: other }: minecraft:block/other",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.baseInvalidContext"
    ]);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    assert.deepStrictEqual(resource.body.statements.map(statement => statement.kind), [
      "BaseStmt",
      "MergeStmt",
      "ForStmt",
      "IfStmt"
    ]);
    const loop = resource.body.statements[2];
    assert.strictEqual(loop.kind, "ForStmt");
    if (loop.kind === "ForStmt") {
      assert.strictEqual(loop.body.kind, "BlockstateVariantsRootBody");
      assert.deepStrictEqual(loop.body.statements.map(statement => statement.kind), [
        "BaseStmt",
        "MergeStmt",
        "BlockstateVariantEntry"
      ]);
    }
    const conditional = resource.body.statements[3];
    assert.strictEqual(conditional.kind, "IfStmt");
    if (conditional.kind === "IfStmt") {
      assert.strictEqual(conditional.thenBody.kind, "BlockstateVariantsRootBody");
      assert.strictEqual(conditional.elseBody?.kind, "BlockstateVariantsRootBody");
    }
  });

  it("parses canonical selectors and apply values into dedicated blockstate AST", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants stairs {",
      "  { facing: north, half: bottom }: minecraft:block/stairs x=90 uvlock=true",
      "  ({ [axis]: direction }): random [",
      "    minecraft:block/a weight=2,",
      "    minecraft:block/b y=180",
      "  ]",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const [inline, parenthesized] = resource.body.statements;
    assert.strictEqual(inline.kind, "BlockstateVariantEntry");
    if (inline.kind === "BlockstateVariantEntry") {
      assert.strictEqual(inline.selectorSyntax, "inlineObject");
      assert.strictEqual(inline.value.kind, "BlockstateApplyExpr");
      if (inline.value.kind === "BlockstateApplyExpr") {
        assert.strictEqual(inline.value.head.kind, "ResourceLocationExpr");
        assert.deepStrictEqual(inline.value.properties.map(property => property.name.text), ["x", "uvlock"]);
      }
    }
    assert.strictEqual(parenthesized.kind, "BlockstateVariantEntry");
    if (parenthesized.kind === "BlockstateVariantEntry") {
      assert.strictEqual(parenthesized.selectorSyntax, "parenthesizedExpression");
      assert.strictEqual(parenthesized.selector.kind, "ObjectExpr");
      if (parenthesized.selector.kind === "ObjectExpr") {
        const firstEntry = parenthesized.selector.properties[0];
        assert.strictEqual(firstEntry?.kind, "ObjectProperty");
        if (firstEntry?.kind === "ObjectProperty") {
          assert.strictEqual(firstEntry.key.kind, "DynamicKey");
        }
      }
      assert.strictEqual(parenthesized.value.kind, "BlockstateRandomValue");
      if (parenthesized.value.kind === "BlockstateRandomValue") {
        assert.deepStrictEqual(
          parenthesized.value.items.map(item => item.properties.map(property => property.name.text)),
          [["weight"], ["y"]]
        );
      }
    }

    const visitedIdentifiers: string[] = [];
    walkRsglModule(module, {
      enterExpression(expression) {
        if (expression.kind === "IdentifierExpr") {
          visitedIdentifiers.push(expression.name.text);
        }
      }
    });
    assert.ok(visitedIdentifiers.includes("axis"));
    assert.ok(visitedIdentifiers.includes("direction"));
  });

  it("parses canonical multipart apply and random values without expression sugar", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate multipart wall {",
      "  when { north: true } apply minecraft:block/wall x=90",
      "  apply random [minecraft:block/a weight=2, minecraft:block/b]",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateMultipartRootBody");
    assert.deepStrictEqual(resource.body.statements.map(statement => statement.kind), [
      "BlockstateMultipartEntry",
      "BlockstateMultipartEntry"
    ]);
    const first = resource.body.statements[0];
    const second = resource.body.statements[1];
    assert.strictEqual(first.kind === "BlockstateMultipartEntry" ? first.apply.kind : "", "BlockstateApplyExpr");
    assert.strictEqual(second.kind === "BlockstateMultipartEntry" ? second.apply.kind : "", "BlockstateRandomValue");
  });

  it("keeps each legacy blockstate form explicit with only directed diagnostics", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate stairs {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stairs x=90",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.blockstateModeRequired",
      "rsgl.legacyBlockstateWrapper",
      "rsgl.legacyStateKeySugar",
      "rsgl.legacyBlockstateEntryArrow",
      "rsgl.legacyModelApplySugar"
    ]);
    assert.strictEqual(resource.body.kind, "LegacyBlockstateRootBody");
    const wrapper = resource.body.statements[0];
    assert.strictEqual(wrapper.kind, "VariantsSection");
    if (wrapper.kind === "VariantsSection") {
      assert.strictEqual(wrapper.syntax, "legacyWrapper");
      const entry = wrapper.entries[0];
      assert.strictEqual(entry.kind, "VariantEntry");
      if (entry.kind === "VariantEntry") {
        assert.strictEqual(entry.syntax, "legacy");
        assert.strictEqual(entry.state.kind, "StateKeySugar");
        assert.strictEqual(entry.value.kind, "ModelApplySugar");
      }
    }
  });

  it("does not generate blockstate sugar from the global expression grammar", () => {
    const modules = [
      parseRsgl("let value = [foo=bar]"),
      parseRsgl("let value = @model"),
      parseRsgl("let value = random [a, b]")
    ];
    const expressionKinds: string[] = [];
    for (const module of modules) {
      walkRsglModule(module, {
        enterExpression(expression) {
          expressionKinds.push(expression.kind);
        }
      });
    }

    assert.ok(expressionKinds.includes("ListExpr"));
    assert.strictEqual(expressionKinds.includes("StateKeySugar"), false);
    assert.strictEqual(expressionKinds.includes("ModelApplySugar"), false);
    assert.strictEqual(expressionKinds.includes("RandomApply"), false);
  });

  it("rejects nested random values with a directed blockstate diagnostic", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants nested_random {",
      "  {}: random [random [minecraft:block/a], minecraft:block/b]",
      "}"
    ].join("\n"));

    assert.ok(module.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.nestedBlockstateModelList"
    ));
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const statement = resource.body.statements[0];
    assert.strictEqual(statement.kind, "BlockstateVariantEntry");
    if (statement.kind === "BlockstateVariantEntry") {
      assert.strictEqual(statement.value.kind, "BlockstateRandomValue");
      if (statement.value.kind === "BlockstateRandomValue") {
        assert.strictEqual(statement.value.items.length, 2);
        assert.strictEqual(statement.value.items[0].head.kind, "MissingExpr");
      }
    }
  });

  it("accepts newline-separated canonical random items", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants multiline_random {",
      "  {}: random [",
      "    minecraft:block/a weight=2",
      "    minecraft:block/b",
      "  ]",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const statement = resource.body.statements[0];
    if (statement.kind === "BlockstateVariantEntry" && statement.value.kind === "BlockstateRandomValue") {
      assert.strictEqual(statement.value.items.length, 2);
    } else {
      assert.fail("expected a canonical random variant entry");
    }
  });

  it("does not consume the next top-level declaration when a blockstate id is missing", () => {
    for (const header of ["blockstate variants", "blockstate"]) {
      const module = parseRsgl([
        header,
        "model block next {}"
      ].join("\n"));

      assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedBlockstateId"));
      assert.strictEqual(module.statements.length, 2);
      assert.strictEqual(module.statements[1].kind, "ResourceDecl");
      if (module.statements[1].kind === "ResourceDecl") {
        assert.strictEqual(module.statements[1].resourceKind, "model");
      }
    }
  });

  it("does not consume following entries when a selector separator or apply head is missing", () => {
    const variants = parseSingleBlockstate([
      "blockstate variants recovered_selector {",
      "  { facing: north }",
      "  {}: minecraft:block/good",
      "}"
    ].join("\n"));
    assert.strictEqual(variants.resource.body.kind, "BlockstateVariantsRootBody");
    assert.deepStrictEqual(variants.resource.body.statements.map(statement => statement.kind), [
      "BlockstateVariantEntry",
      "BlockstateVariantEntry"
    ]);

    const multipart = parseSingleBlockstate([
      "blockstate multipart recovered_apply {",
      "  apply",
      "  apply minecraft:block/good",
      "}"
    ].join("\n"));
    assert.strictEqual(multipart.resource.body.kind, "BlockstateMultipartRootBody");
    assert.deepStrictEqual(multipart.resource.body.statements.map(statement => statement.kind), [
      "BlockstateMultipartEntry",
      "BlockstateMultipartEntry"
    ]);
  });

  it("recovers malformed entries without consuming the following statement", () => {
    const missingColon = parseSingleBlockstate([
      "blockstate variants recovered_colon {",
      "  { facing: north } minecraft:block/bad",
      "  {}: minecraft:block/good",
      "}"
    ].join("\n"));
    assert.ok(missingColon.module.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.expectedToken"
    ));
    assert.deepStrictEqual(missingColon.resource.body.statements.map(statement => statement.kind), [
      "BlockstateVariantEntry",
      "BlockstateVariantEntry"
    ]);

    const unterminatedRandom = parseSingleBlockstate([
      "blockstate variants recovered_random {",
      "  { facing: north }: random [minecraft:block/bad",
      "  {}: minecraft:block/good",
      "}"
    ].join("\n"));
    assert.ok(unterminatedRandom.module.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.expectedClosingBracket"
    ));
    assert.deepStrictEqual(unterminatedRandom.resource.body.statements.map(statement => statement.kind), [
      "BlockstateVariantEntry",
      "BlockstateVariantEntry"
    ]);
  });
});
