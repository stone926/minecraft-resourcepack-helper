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
    assert.strictEqual(variants.resource.mode, "variants");
    assert.strictEqual(variants.resource.modeNode.text, "variants");
    assert.strictEqual(variants.resource.body.kind, "BlockstateVariantsRootBody");

    const multipart = parseSingleBlockstate("blockstate multipart multipart {}");
    assert.deepStrictEqual(multipart.module.diagnostics, []);
    assert.strictEqual(multipart.resource.mode, "multipart");
    assert.strictEqual(multipart.resource.body.kind, "BlockstateMultipartRootBody");
  });

  it("recommends parentheses around complex dynamic blockstate ids", () => {
    const unparenthesized = parseSingleBlockstate(
      'blockstate variants type == "nest" ? "bee_nest" : "beehive" {}'
    );
    assert.strictEqual(unparenthesized.resource.id.kind, "ConditionalExpr");
    assert.deepStrictEqual(
      unparenthesized.module.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity]),
      [["rsgl.blockstateDynamicIdParenthesesRecommended", "warning"]]
    );

    const groupedConditionOnly = parseSingleBlockstate(
      'blockstate variants (type == "nest") ? "bee_nest" : build_id("beehive") {}'
    );
    assert.deepStrictEqual(
      groupedConditionOnly.module.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.blockstateDynamicIdParenthesesRecommended"]
    );

    const parenthesized = parseSingleBlockstate(
      'blockstate variants (type == "nest" ? "bee_nest" : "beehive") {}'
    );
    assert.strictEqual(parenthesized.resource.id.kind, "ConditionalExpr");
    assert.deepStrictEqual(parenthesized.module.diagnostics, []);
  });

  it("rejects missing and unknown modes without producing resource declarations", () => {
    const missing = parseRsgl("blockstate stairs {}");
    assert.deepStrictEqual(missing.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.blockstateModeRequired"
    ]);
    assert.strictEqual(missing.statements[0]?.kind, "UnknownStmt");

    const unknown = parseRsgl("blockstate variant stairs {}");
    assert.deepStrictEqual(unknown.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.unknownBlockstateMode"
    ]);
    assert.strictEqual(unknown.statements[0]?.kind, "UnknownStmt");
  });

  it("parses case selectors, wildcard selectors, aliases, computed keys, and shorthand", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants stairs {",
      "  case * => minecraft:block/default",
      "  case { facing, half, open: isOpen, [property]: value } =>",
      "    minecraft:block/stairs with { x, y: rotation, uvlock: true }",
      "  case entry.state => entry.choice",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const [wildcard, record, dataDriven] = resource.body.statements;
    assert.strictEqual(wildcard.kind, "BlockstateVariantEntry");
    assert.strictEqual(record.kind, "BlockstateVariantEntry");
    assert.strictEqual(dataDriven.kind, "BlockstateVariantEntry");
    if (
      wildcard.kind !== "BlockstateVariantEntry"
      || record.kind !== "BlockstateVariantEntry"
      || dataDriven.kind !== "BlockstateVariantEntry"
    ) {
      throw new Error("Expected variant entries.");
    }

    assert.strictEqual(wildcard.selector.kind, "BlockstateWildcardSelector");
    assert.strictEqual(wildcard.choice.kind, "BlockstateModelSpec");
    assert.strictEqual(record.selector.kind, "ObjectExpr");
    assert.strictEqual(record.choice.kind, "BlockstateModelSpec");
    if (record.selector.kind === "ObjectExpr") {
      assert.deepStrictEqual(
        record.selector.properties.map(property =>
          property.kind === "ObjectProperty" ? [property.key.kind, property.shorthand === true] : [property.kind, false]
        ),
        [
          ["Identifier", true],
          ["Identifier", true],
          ["Identifier", false],
          ["DynamicKey", false]
        ]
      );
    }
    if (record.choice.kind === "BlockstateModelSpec") {
      assert.strictEqual(record.choice.model.kind, "ResourceLocationExpr");
      assert.strictEqual(record.choice.options?.kind, "ObjectExpr");
      assert.deepStrictEqual(
        record.choice.options?.properties.map(property =>
          property.kind === "ObjectProperty" ? [property.key.kind, property.shorthand === true] : [property.kind, false]
        ),
        [
          ["Identifier", true],
          ["Identifier", false],
          ["Identifier", false]
        ]
      );
    }
    assert.strictEqual(dataDriven.selector.kind, "MemberExpr");
    assert.strictEqual(dataDriven.choice.kind, "BlockstateModelSpec");
    if (dataDriven.choice.kind === "BlockstateModelSpec") {
      assert.strictEqual(dataDriven.choice.model.kind, "MemberExpr");
    }
  });

  it("parses part always and typed state predicates with membership operators", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate multipart wall {",
      "  part always => minecraft:block/wall_post",
      "  part when (",
      "    $state.power in 1..15 &&",
      "    $state.facing not in [north, south] &&",
      "    !($state[direction] == false)",
      "  ) => minecraft:block/wall_side with { y: yaw(direction) }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateMultipartRootBody");
    const [always, conditional] = resource.body.statements;
    assert.strictEqual(always.kind, "BlockstateMultipartEntry");
    assert.strictEqual(conditional.kind, "BlockstateMultipartEntry");
    if (always.kind !== "BlockstateMultipartEntry" || conditional.kind !== "BlockstateMultipartEntry") {
      throw new Error("Expected multipart entries.");
    }
    assert.strictEqual(always.always, true);
    assert.strictEqual(always.predicate, undefined);
    assert.strictEqual(conditional.always, false);
    assert.strictEqual(conditional.predicate?.kind, "BinaryExpr");
    assert.strictEqual(conditional.choice.kind, "BlockstateModelSpec");

    const operators: string[] = [];
    walkRsglModule(module, {
      enterExpression(expression) {
        if (expression.kind === "BinaryExpr") {
          operators.push(expression.operator);
        }
      }
    });
    assert.ok(operators.includes("in"));
    assert.ok(operators.includes("not in"));
    assert.ok(operators.includes("&&"));
  });

  it("parses random choice bodies with options, weights, control flow, and choice fragments", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants animated {",
      "  case * => random {",
      "    let optionWeight = 1 + 2",
      "    option minecraft:block/base weight optionWeight",
      "    for idx in 0..1 {",
      "      option `minecraft:block/frame_${idx}` with { y: idx * 90 }",
      "    }",
      "    if enabled {",
      "      use extra_choices()",
      "    } else {",
      "      option minecraft:block/fallback",
      "    }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const entry = resource.body.statements[0];
    assert.strictEqual(entry.kind, "BlockstateVariantEntry");
    if (entry.kind !== "BlockstateVariantEntry" || entry.choice.kind !== "BlockstateRandomChoice") {
      throw new Error("Expected a random variant choice.");
    }
    assert.deepStrictEqual(entry.choice.body.statements.map(statement => statement.kind), [
      "LetDecl",
      "BlockstateRandomOption",
      "ForStmt",
      "IfStmt"
    ]);
    const option = entry.choice.body.statements[1];
    assert.strictEqual(option.kind, "BlockstateRandomOption");
    if (option.kind === "BlockstateRandomOption") {
      assert.strictEqual(option.model.kind, "BlockstateModelSpec");
      assert.strictEqual(option.weight?.kind, "IdentifierExpr");
    }
    const loop = entry.choice.body.statements[2];
    assert.strictEqual(loop.kind, "ForStmt");
    if (loop.kind === "ForStmt") {
      assert.strictEqual(loop.body.kind, "BlockstateChoiceBody");
      assert.strictEqual(loop.body.statements[0]?.kind, "BlockstateRandomOption");
    }
    const conditional = entry.choice.body.statements[3];
    assert.strictEqual(conditional.kind, "IfStmt");
    if (conditional.kind === "IfStmt") {
      assert.strictEqual(conditional.thenBody.kind, "BlockstateChoiceBody");
      assert.strictEqual(conditional.elseBody?.kind, "BlockstateChoiceBody");
    }
  });

  it("parses the choice template dialect and retains it through control flow", () => {
    const module = parseRsgl([
      "template fire_options(model: ModelId) -> choice {",
      "  for rotation in [0, 90] {",
      "    option model with { y: rotation } weight rotation + 1",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const template = module.statements[0];
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind !== "TemplateDecl") {
      throw new Error("Expected a template declaration.");
    }
    assert.strictEqual(template.declaredOutputDialect, "choice");
    assert.strictEqual(template.body.kind, "BlockstateChoiceBody");
    if (template.body.kind === "BlockstateChoiceBody") {
      const loop = template.body.statements[0];
      assert.strictEqual(loop.kind, "ForStmt");
      if (loop.kind === "ForStmt") {
        assert.strictEqual(loop.body.kind, "BlockstateChoiceBody");
      }
    }
  });

  it("keeps root entry dialects through nested for and if bodies", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants nested {",
      "  for value in values {",
      "    case { key: value } => minecraft:block/value",
      "  }",
      "  if enabled {",
      "    case * => minecraft:block/enabled",
      "  } else {",
      "    use fallback_variants()",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    const loop = resource.body.statements[0];
    const conditional = resource.body.statements[1];
    assert.strictEqual(loop.kind, "ForStmt");
    assert.strictEqual(conditional.kind, "IfStmt");
    if (loop.kind === "ForStmt") {
      assert.strictEqual(loop.body.kind, "BlockstateVariantsRootBody");
    }
    if (conditional.kind === "IfStmt") {
      assert.strictEqual(conditional.thenBody.kind, "BlockstateVariantsRootBody");
      assert.strictEqual(conditional.elseBody?.kind, "BlockstateVariantsRootBody");
    }
  });

  it("rejects empty selector objects in favor of case wildcard", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate variants invalid_empty {",
      "  case {} => minecraft:block/bad",
      "  case * => minecraft:block/good",
      "}"
    ].join("\n"));

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.emptyBlockstateSelector"));
    assert.strictEqual(resource.body.kind, "BlockstateVariantsRootBody");
    assert.strictEqual(resource.body.statements[1]?.kind, "BlockstateVariantEntry");
  });

  it("rejects empty and nested random choices with directed diagnostics", () => {
    const empty = parseSingleBlockstate("blockstate variants empty { case * => random {} }");
    assert.ok(empty.module.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.emptyBlockstateRandomChoice"
    ));

    const nested = parseSingleBlockstate([
      "blockstate variants nested {",
      "  case * => random {",
      "    option random { option minecraft:block/a }",
      "  }",
      "}"
    ].join("\n"));
    assert.ok(nested.module.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.nestedBlockstateChoice"
    ));
  });

  it("rejects every removed blockstate surface without producing legacy AST", () => {
    const cases: Array<[string, string]> = [
      [
        "blockstate old { variants { [facing=north] -> @minecraft:block/old } }",
        "rsgl.blockstateModeRequired"
      ],
      [
        "blockstate variants old { [facing=north] -> minecraft:block/old }",
        "rsgl.expectedBlockstateCase"
      ],
      [
        "blockstate variants old { case * => @minecraft:block/old }",
        "rsgl.expectedExpression"
      ],
      [
        "blockstate variants old { { facing: north }: minecraft:block/old }",
        "rsgl.legacyBlockstateVariantEntry"
      ],
      [
        "blockstate multipart old { apply minecraft:block/old }",
        "rsgl.legacyBlockstateMultipartEntry"
      ],
      [
        "blockstate multipart old { when { north: true } apply minecraft:block/old }",
        "rsgl.legacyBlockstateMultipartEntry"
      ],
      [
        "blockstate variants old { case * => minecraft:block/old x=90 }",
        "rsgl.legacyBlockstateModelModifiers"
      ],
      [
        "blockstate variants old { case * => { model: minecraft:block/old } }",
        "rsgl.legacyBlockstateModelValue"
      ],
      [
        "blockstate variants old { case * => [minecraft:block/a, minecraft:block/b] }",
        "rsgl.legacyBlockstateModelValue"
      ],
      [
        "blockstate variants old { case * => random [minecraft:block/a, minecraft:block/b] }",
        "rsgl.legacyBlockstateRandomList"
      ]
    ];

    for (const [source, code] of cases) {
      const parsed = parseRsgl(source);
      assert.ok(parsed.diagnostics.some(diagnostic => diagnostic.code === code), `${code}: ${source}`);
    }
  });

  it("balances removed multiline multipart entries and retains the next canonical part", () => {
    const { module, resource } = parseSingleBlockstate([
      "blockstate multipart recovered_legacy {",
      "  apply {",
      "    model: minecraft:block/old",
      "    y: 90",
      "  }",
      "  when {",
      "    OR: [{ north: true }, { south: true }]",
      "  } apply random [",
      "    { model: minecraft:block/old_a },",
      "    { model: minecraft:block/old_b }",
      "  ]; part always => minecraft:block/good",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.legacyBlockstateMultipartEntry",
      "rsgl.legacyBlockstateMultipartEntry"
    ]);
    assert.strictEqual(resource.body.kind, "BlockstateMultipartRootBody");
    assert.deepStrictEqual(resource.body.statements.map(statement => statement.kind), [
      "UnknownStmt",
      "UnknownStmt",
      "BlockstateMultipartEntry"
    ]);
  });

  it("rejects separated legacy model modifiers after both case and part entries", () => {
    const variants = parseSingleBlockstate([
      "blockstate variants misplaced_variants {",
      "  case { slot: a } => minecraft:block/a, x=90",
      "  case { slot: b } => minecraft:block/b; y=180",
      "  case { slot: c } => minecraft:block/c",
      "  z=270",
      "  case { slot: d } => minecraft:block/d,",
      "  uvlock=true",
      "  case * => minecraft:block/default,",
      "  weight=2",
      "  case { slot: e } => minecraft:block/good",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(variants.module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.blockstateWeightInvalidContext"
    ]);
    assert.strictEqual(variants.resource.body.kind, "BlockstateVariantsRootBody");
    assert.deepStrictEqual(variants.resource.body.statements.map(statement => statement.kind), [
      "BlockstateVariantEntry", "UnknownStmt",
      "BlockstateVariantEntry", "UnknownStmt",
      "BlockstateVariantEntry", "UnknownStmt",
      "BlockstateVariantEntry", "UnknownStmt",
      "BlockstateVariantEntry", "UnknownStmt",
      "BlockstateVariantEntry"
    ]);

    const multipart = parseSingleBlockstate([
      "blockstate multipart misplaced_multipart {",
      "  part always => minecraft:block/a, x=90",
      "  part always => minecraft:block/b; uvlock=true",
      "  part always => minecraft:block/c",
      "  weight=3",
      "  part always => minecraft:block/good",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(multipart.module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.legacyBlockstateModelModifiers",
      "rsgl.blockstateWeightInvalidContext"
    ]);
    assert.strictEqual(multipart.resource.body.kind, "BlockstateMultipartRootBody");
    assert.deepStrictEqual(multipart.resource.body.statements.map(statement => statement.kind), [
      "BlockstateMultipartEntry", "UnknownStmt",
      "BlockstateMultipartEntry", "UnknownStmt",
      "BlockstateMultipartEntry", "UnknownStmt",
      "BlockstateMultipartEntry"
    ]);
  });

  it("recovers malformed rules without consuming the following entry", () => {
    const variants = parseSingleBlockstate([
      "blockstate variants recovered {",
      "  case { facing: north }",
      "  case * => minecraft:block/good",
      "}"
    ].join("\n"));
    assert.strictEqual(variants.resource.body.kind, "BlockstateVariantsRootBody");
    assert.deepStrictEqual(variants.resource.body.statements.map(statement => statement.kind), [
      "UnknownStmt",
      "BlockstateVariantEntry"
    ]);

    const multipart = parseSingleBlockstate([
      "blockstate multipart recovered {",
      "  part sometimes => minecraft:block/bad",
      "  part always => minecraft:block/good",
      "}"
    ].join("\n"));
    assert.strictEqual(multipart.resource.body.kind, "BlockstateMultipartRootBody");
    assert.deepStrictEqual(multipart.resource.body.statements.map(statement => statement.kind), [
      "UnknownStmt",
      "BlockstateMultipartEntry"
    ]);
  });

  it("walks selectors, predicates, model options, random options, and weights", () => {
    const module = parseRsgl([
      "blockstate multipart walked {",
      "  part when $state[direction] == enabled => random {",
      "    option model with { x, y: rotation } weight weightValue",
      "  }",
      "}"
    ].join("\n"));
    assert.deepStrictEqual(module.diagnostics, []);

    const statements: string[] = [];
    const identifiers: string[] = [];
    walkRsglModule(module, {
      enterStatement(statement) {
        statements.push(statement.kind);
      },
      enterExpression(expression) {
        if (expression.kind === "IdentifierExpr") {
          identifiers.push(expression.name.text);
        }
      }
    });

    assert.deepStrictEqual(statements, [
      "ResourceDecl",
      "BlockstateMultipartEntry",
      "BlockstateRandomOption"
    ]);
    assert.deepStrictEqual(identifiers, [
      "walked",
      "$state",
      "direction",
      "enabled",
      "model",
      "x",
      "rotation",
      "weightValue"
    ]);
  });
});
