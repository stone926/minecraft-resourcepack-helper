import * as assert from "node:assert";
import { compileRsglModule } from "../../src/compiler";
import { formatRsglText } from "../../src/formatterCore";
import {
  parseRsgl,
  type ItemFallbackClauseNode,
  type ItemModelSelectNode,
  type ItemSelectCaseNode
} from "../../src/parser";
import { compileSourceWithUncheckedExterns } from "./helpers/compile";

describe("RSGL arrow semantics", () => {
  it("uses mapping arrows for behavior and output-contract arrows for declarations", () => {
    const source = [
      "let identity = value => value",
      "let choose = (left, right) => left",
      "let result = match mode {",
      "  (north) | south =>",
      "    \"horizontal\"",
      "  _ => \"fallback\"",
      "}",
      "type Mapper = (Json) -> ModelId",
      "template fields() -> model { parent minecraft:block/cube_all }",
      "blockstate variants lamp {",
      "  case ({ powered: true }) => minecraft:block/lamp_on",
      "}",
      "blockstate multipart lamp_overlay {",
      "  part when ($state.powered == true) => minecraft:block/lamp_glow",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case (\"minecraft:healing\") =>",
      "      minecraft:item/potion_healing",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics, []);
    const match = module.statements[2];
    assert.strictEqual(match.kind, "LetDecl");
    assert.strictEqual(match.kind === "LetDecl" ? match.value.kind : undefined, "MatchExpr");
  });

  it("keeps an indented lambda as a multiline match-arm value", () => {
    const source = [
      "let mapper = match mode {",
      "  _ =>",
      "    value => value",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    const formattedModule = parseRsgl(formatRsglText(source));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(formattedModule.diagnostics, []);
    const declaration = module.statements[0];
    assert.strictEqual(declaration.kind, "LetDecl");
    assert.strictEqual(
      declaration.kind === "LetDecl" && declaration.value.kind === "MatchExpr"
        ? declaration.value.arms[0].value.kind
        : undefined,
      "LambdaExpr"
    );
    const formattedDeclaration = formattedModule.statements[0];
    assert.strictEqual(
      formattedDeclaration.kind === "LetDecl" && formattedDeclaration.value.kind === "MatchExpr"
        ? formattedDeclaration.value.arms[0].value.kind
        : undefined,
      "LambdaExpr"
    );
  });

  it("keeps contextual item keywords available as multiline mapping values", () => {
    const source = [
      "let fallback = minecraft:item/potion",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\" =>",
      "      fallback",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const select = itemSelectStatement(module.statements[1]);
    const cases = itemSelectCases(select);

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(cases[0]?.model.kind, "ItemModelExpr");
    assert.strictEqual(
      cases[0]?.model.kind === "ItemModelExpr" ? cases[0].model.expression.kind : undefined,
      "IdentifierExpr"
    );
    assert.strictEqual(itemSelectFallback(select), undefined);
  });

  it("does not recognize an output-contract arrow as a lambda or blockstate mapping", () => {
    const lambda = parseRsgl("let identity = value -> value");
    assert.ok(lambda.diagnostics.some(diagnostic => diagnostic.severity === "error"));
    assert.ok(lambda.diagnostics.every(diagnostic => !/unexpected(?:OutputContract|Mapping)Arrow/.test(diagnostic.code)));
    const declaration = lambda.statements[0];
    assert.strictEqual(
      declaration.kind === "LetDecl" ? declaration.value.kind : undefined,
      "IdentifierExpr"
    );
    assert.ok(lambda.statements.some(statement => statement.kind === "UnknownStmt"));

    const source = "blockstate variants lamp { case * -> minecraft:block/lamp }";
    const blockstate = parseRsgl(source);
    assert.deepStrictEqual(blockstate.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.expectedMappingArrow"
    ]);
    const resource = blockstate.statements[0];
    assert.strictEqual(
      resource.kind === "ResourceDecl" ? resource.body.statements[0]?.kind : undefined,
      "UnknownStmt"
    );
    assert.deepStrictEqual(compileRsglModule(blockstate).units, []);
  });

  it("does not recognize a mapping arrow as an output contract", () => {
    const typeAlias = parseRsgl("type Mapper = (Json) => ModelId");
    assert.ok(typeAlias.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedOutputContractArrow"));
    const declaration = typeAlias.statements[0];
    assert.strictEqual(
      declaration.kind === "TypeAliasDecl" && declaration.typeAnnotation.kind === "FunctionType"
        ? declaration.typeAnnotation.returnType.kind
        : undefined,
      "MissingType"
    );

    const template = parseRsgl("template fields() => model { parent minecraft:block/cube_all }");
    assert.ok(template.diagnostics.some(diagnostic => diagnostic.severity === "error"));
    const templateDeclaration = template.statements[0];
    assert.strictEqual(
      templateDeclaration.kind === "TemplateDecl" ? templateDeclaration.declaredOutputDialect : undefined,
      undefined
    );
    assert.ok([...typeAlias.diagnostics, ...template.diagnostics].every(diagnostic =>
      !/unexpected(?:OutputContract|Mapping)Arrow/.test(diagnostic.code)
    ));
  });

  it("reports a missing function output contract without consuming the return type or next declaration", () => {
    const source = [
      "type Mapper = (Json) ModelId",
      "type Broken = (Json)",
      "let after = 1"
    ].join("\n");

    const module = parseRsgl(source);

    assert.strictEqual(
      module.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.expectedOutputContractArrow").length,
      2
    );
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), [
      "TypeAliasDecl",
      "TypeAliasDecl",
      "LetDecl"
    ]);
    const mapper = module.statements[0];
    const broken = module.statements[1];
    assert.strictEqual(
      mapper.kind === "TypeAliasDecl" && mapper.typeAnnotation.kind === "FunctionType"
        ? mapper.typeAnnotation.returnType.kind
        : undefined,
      "NamedType"
    );
    assert.strictEqual(
      broken.kind === "TypeAliasDecl" && broken.typeAnnotation.kind === "FunctionType"
        ? broken.typeAnnotation.returnType.kind
        : undefined,
      "MissingType"
    );
  });

  it("keeps missing arrows local without consuming the following arm or clause", () => {
    const source = [
      "let result = match mode {",
      "  north",
      "  south => 2",
      "  _ => 3",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\"",
      "    case \"minecraft:water\" => minecraft:item/potion_water",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.expectedMappingArrow",
      "rsgl.expectedMappingArrow"
    ]);
    const matchDecl = module.statements[0];
    assert.strictEqual(matchDecl.kind, "LetDecl");
    if (matchDecl.kind === "LetDecl" && matchDecl.value.kind === "MatchExpr") {
      assert.strictEqual(matchDecl.value.arms.length, 3);
      assert.strictEqual(matchDecl.value.arms[1].patterns[0].kind, "IdentifierExpr");
    } else {
      assert.fail("Expected recovered match expression.");
    }
    const select = itemSelectStatement(module.statements[1]);
    const cases = itemSelectCases(select);
    assert.strictEqual(cases.length, 2);
    assert.strictEqual(cases[1].when.kind, "StringLiteral");
  });

  it("preserves same-line clauses across optional separators during recovery", () => {
    const source = [
      "let result = match mode { north, south => 2; _ => 3 }",
      "blockstate variants lamp { case *, case * => minecraft:block/lamp }",
      "blockstate multipart lamp_overlay { part always, part always => minecraft:block/glow }",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\", case \"minecraft:water\" => minecraft:item/potion_water, fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.expectedMappingArrow",
      "rsgl.expectedMappingArrow",
      "rsgl.expectedMappingArrow",
      "rsgl.expectedMappingArrow"
    ]);
    const matchDecl = module.statements[0];
    assert.strictEqual(
      matchDecl.kind === "LetDecl" && matchDecl.value.kind === "MatchExpr"
        ? matchDecl.value.arms.length
        : undefined,
      3
    );
    assert.strictEqual(
      module.statements[1].kind === "ResourceDecl" ? module.statements[1].body.statements.length : undefined,
      2
    );
    assert.strictEqual(
      module.statements[2].kind === "ResourceDecl" ? module.statements[2].body.statements.length : undefined,
      2
    );
    const select = itemSelectStatement(module.statements[3]);
    assert.strictEqual(itemSelectCases(select).length, 2);
    assert.strictEqual(itemModelExpressionKind(itemSelectFallback(select)?.model), "ResourceLocationExpr");
  });

  it("does not consume a closing body delimiter when a mapping RHS is missing", () => {
    const source = [
      "let result = match mode {",
      "  _ =>",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\" =>",
      "  }",
      "}"
    ].join("\n");
    const module = parseRsgl(source);

    assert.strictEqual(
      module.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.expectedExpression").length,
      2
    );
    assert.strictEqual(
      module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedClosingBrace"),
      false
    );
    assert.strictEqual(itemSelectCases(itemSelectStatement(module.statements[1])).length, 1);
  });

  it("does not consume a following arm or clause after a separated canonical arrow with no RHS", () => {
    const source = [
      "let result = match mode {",
      "  north =>;",
      "  south => 2",
      "  _ => 3",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\" =>;",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const matchDecl = module.statements[0];

    assert.strictEqual(
      module.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.expectedExpression").length,
      2
    );
    if (matchDecl.kind === "LetDecl" && matchDecl.value.kind === "MatchExpr") {
      assert.strictEqual(matchDecl.value.arms.length, 3);
      assert.strictEqual(matchDecl.value.arms[1].patterns[0].kind, "IdentifierExpr");
    } else {
      assert.fail("Expected recovered match expression.");
    }
    const select = itemSelectStatement(module.statements[1]);
    assert.strictEqual(itemSelectCases(select).length, 1);
    assert.strictEqual(itemModelExpressionKind(itemSelectFallback(select)?.model), "ResourceLocationExpr");
  });

  it("reports wrong mapping arrows as ordinary syntax errors inside template strings", () => {
    const source = [
      "model block sample {",
      "  parent `minecraft:block/${match key { _ -> \"cube_all\" }}`",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const diagnostic = module.diagnostics.find(candidate => candidate.code === "rsgl.expectedMappingArrow");

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "->");
    const result = compileRsglModule(module);
    assert.deepStrictEqual(result.units, []);
  });

  it("does not construct a lambda from the wrong arrow inside a template string", () => {
    const source = "let rendered = `${(name -> name)(\"cube_all\")}`";
    const module = parseRsgl(source);
    assert.ok(module.diagnostics.some(candidate => candidate.code === "rsgl.expectedClosingParen"));
    const declaration = module.statements[0];
    assert.strictEqual(declaration.kind, "LetDecl");
    if (declaration.kind !== "LetDecl" || declaration.value.kind !== "TemplateStringExpr") {
      assert.fail("Expected a template string value.");
    }
    const part = declaration.value.parts.find(candidate => candidate.kind === "expression");
    assert.ok(part && part.kind === "expression");
    if (!part || part.kind !== "expression") {
      assert.fail("Expected an expression interpolation.");
    }
    assert.strictEqual(part.expression.kind, "IdentifierExpr");
  });

  it("blocks resource output after a wrong mapping arrow", () => {
    const source = [
      "blockstate variants lamp {",
      "  case { powered: true } -> minecraft:block/lamp_on",
      "}"
    ].join("\n");

    const result = compileRsglModule(parseRsgl(source));

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.expectedMappingArrow"
    ));
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects wrong mapping arrows while canonical sources still compile", () => {
    const cases = [
      {
        invalid: [
          "model block sample {",
          "  parent match true { _ -> minecraft:block/cube_all }",
          "}"
        ],
        canonical: [
          "model block sample {",
          "  parent match true { _ => minecraft:block/cube_all }",
          "}"
        ]
      },
      {
        invalid: [
          "item potion {",
          "  select property minecraft:potion_contents {",
          "    case \"minecraft:healing\" -> minecraft:item/potion_healing",
          "    fallback minecraft:item/potion",
          "  }",
          "}"
        ],
        canonical: [
          "item potion {",
          "  select property minecraft:potion_contents {",
          "    case \"minecraft:healing\" => minecraft:item/potion_healing",
          "    fallback minecraft:item/potion",
          "  }",
          "}"
        ]
      }
    ];

    for (const { invalid, canonical } of cases) {
      const invalidResult = compileSourceWithUncheckedExterns(invalid);
      assert.ok(invalidResult.diagnostics.some(candidate => candidate.code === "rsgl.expectedMappingArrow"));
      assert.deepStrictEqual(invalidResult.units, []);

      const canonicalResult = compileSourceWithUncheckedExterns(canonical);
      assert.deepStrictEqual(canonicalResult.diagnostics, []);
      assert.ok(canonicalResult.units.length > 0);
    }
  });
});

function itemSelectStatement(statement: ReturnType<typeof parseRsgl>["statements"][number]): ItemModelSelectNode | undefined {
  if (statement.kind !== "ResourceDecl") {
    return undefined;
  }
  const candidate = statement.body.statements.find(item => item.kind === "ItemModelProducerStmt");
  return candidate?.kind === "ItemModelProducerStmt" && candidate.value.kind === "ItemModelSelect"
    ? candidate.value
    : undefined;
}

function itemSelectCases(select: ItemModelSelectNode | undefined): ItemSelectCaseNode[] {
  return select?.body.statements.filter(
    (statement): statement is ItemSelectCaseNode => statement.kind === "ItemSelectCase"
  ) ?? [];
}

function itemSelectFallback(select: ItemModelSelectNode | undefined): ItemFallbackClauseNode | undefined {
  return select?.body.statements.find(
    (statement): statement is ItemFallbackClauseNode => statement.kind === "ItemFallbackClause"
  );
}

function itemModelExpressionKind(
  model: ItemSelectCaseNode["model"] | undefined
): string | undefined {
  return model?.kind === "ItemModelExpr" ? model.expression.kind : model?.kind;
}
