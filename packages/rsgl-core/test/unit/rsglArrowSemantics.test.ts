import * as assert from "node:assert";
import { compileRsglModule } from "../../src/compiler";
import { formatRsglText } from "../../src/formatterCore";
import { parseRsgl, type ItemSelectStmtNode } from "../../src/parser";
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

    assert.deepStrictEqual(module.diagnostics, []);
    assert.strictEqual(select?.cases[0].model.kind, "IdentifierExpr");
    assert.strictEqual(select?.fallback, undefined);
  });

  it("reports every output-contract arrow used in a mapping at the arrow token", () => {
    const source = [
      "let identity = value -> value",
      "let choose = (left, right) -> left",
      "let result = match mode { (north) -> \"north\" }",
      "blockstate variants lamp { case ({ powered: true }) -> minecraft:block/lamp_on }",
      "blockstate multipart lamp_overlay { part when ($state.powered == true) -> minecraft:block/lamp_glow }",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case (\"minecraft:healing\") -> minecraft:item/potion_healing",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const diagnostics = module.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.unexpectedOutputContractArrow"
    );

    assert.strictEqual(diagnostics.length, 6);
    assert.ok(diagnostics.every(diagnostic =>
      source.slice(diagnostic.range.start, diagnostic.range.end) === "->"
    ));
    assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("lambda expression")));
    assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("match arm")));
    assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("item select case")));
    assert.strictEqual(module.diagnostics.length, diagnostics.length, "wrong arrows should recover without cascades");
  });

  it("reports mapping arrows used in output contracts and preserves recovered declarations", () => {
    const source = [
      "type Mapper = (Json) => ModelId",
      "template fields() => model { parent minecraft:block/cube_all }"
    ].join("\n");

    const module = parseRsgl(source);
    const diagnostics = module.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.unexpectedMappingArrow"
    );

    assert.strictEqual(diagnostics.length, 2);
    assert.ok(diagnostics.every(diagnostic =>
      source.slice(diagnostic.range.start, diagnostic.range.end) === "=>"
    ));
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "TemplateDecl"]);
    assert.strictEqual(module.diagnostics.length, diagnostics.length);
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
    assert.strictEqual(select?.cases.length, 2);
    assert.strictEqual(select?.cases[1].when.kind, "StringLiteral");
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
    assert.strictEqual(select?.cases.length, 2);
    assert.strictEqual(select?.fallback?.kind, "ResourceLocationExpr");
  });

  it("does not consume a closing body delimiter when a mapping RHS is missing", () => {
    for (const arrow of ["=>", "->"] as const) {
      const source = [
        "let result = match mode {",
        `  _ ${arrow}`,
        "}",
        "item potion {",
        "  select property minecraft:potion_contents {",
        `    case "minecraft:healing" ${arrow}`,
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
      assert.strictEqual(itemSelectStatement(module.statements[1])?.cases.length, 1);
    }
  });

  it("does not consume a following arm or clause after an arrow with no RHS", () => {
    const source = [
      "let result = match mode {",
      "  north ->",
      "  south => 2",
      "  _ => 3",
      "}",
      "item potion {",
      "  select property minecraft:potion_contents {",
      "    case \"minecraft:healing\" ->",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const matchDecl = module.statements[0];

    assert.strictEqual(
      module.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.unexpectedOutputContractArrow").length,
      2
    );
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
    assert.strictEqual(select?.cases.length, 1);
    assert.strictEqual(select?.fallback?.kind, "ResourceLocationExpr");
  });

  it("propagates wrong-arrow diagnostics out of template-string interpolations", () => {
    const source = [
      "model block sample {",
      "  parent `minecraft:block/${match key { _ -> \"cube_all\" }}`",
      "}"
    ].join("\n");

    const module = parseRsgl(source);
    const diagnostic = module.diagnostics.find(candidate =>
      candidate.code === "rsgl.unexpectedOutputContractArrow"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "->");
    const result = compileRsglModule(module);
    assert.deepStrictEqual(result.units, []);
  });

  it("keeps recovered lambda ranges absolute inside template-string interpolations", () => {
    const source = "let rendered = `${(name -> name)(\"cube_all\")}`";
    const module = parseRsgl(source);
    const diagnostic = module.diagnostics.find(candidate =>
      candidate.code === "rsgl.unexpectedOutputContractArrow"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "->");
    const declaration = module.statements[0];
    assert.strictEqual(declaration.kind, "LetDecl");
    if (declaration.kind !== "LetDecl" || declaration.value.kind !== "TemplateStringExpr") {
      assert.fail("Expected a template string value.");
    }
    const part = declaration.value.parts.find(candidate => candidate.kind === "expression");
    assert.ok(part && part.kind === "expression");
    if (!part || part.kind !== "expression" || part.expression.kind !== "CallExpr") {
      assert.fail("Expected a call expression interpolation.");
    }
    assert.strictEqual(part.expression.callee.kind, "LambdaExpr");
    if (part.expression.callee.kind === "LambdaExpr") {
      assert.strictEqual(source.slice(
        part.expression.callee.parameters[0].range.start,
        part.expression.callee.parameters[0].range.end
      ), "name");
      assert.strictEqual(source.slice(
        part.expression.callee.body.range.start,
        part.expression.callee.body.range.end
      ), "name");
    }
  });

  it("blocks resource output after recovering a wrong mapping arrow", () => {
    const source = [
      "blockstate variants lamp {",
      "  case { powered: true } -> minecraft:block/lamp_on",
      "}"
    ].join("\n");

    const result = compileRsglModule(parseRsgl(source));

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unexpectedOutputContractArrow"
    ));
    assert.deepStrictEqual(result.units, []);
  });

  it("rejects both migrated legacy constructs and compiles their arrow-only fixes", () => {
    const legacySources = [
      [
        "model block sample {",
        "  parent match true { _ -> minecraft:block/cube_all }",
        "}"
      ],
      [
        "item potion {",
        "  select property minecraft:potion_contents {",
        "    case \"minecraft:healing\" -> minecraft:item/potion_healing",
        "    fallback minecraft:item/potion",
        "  }",
        "}"
      ]
    ];

    for (const lines of legacySources) {
      const source = lines.join("\n");
      const module = parseRsgl(source);
      const diagnostic = module.diagnostics.find(candidate =>
        candidate.code === "rsgl.unexpectedOutputContractArrow"
      );
      assert.ok(diagnostic);
      const legacyResult = compileSourceWithUncheckedExterns(lines);
      assert.deepStrictEqual(legacyResult.units, []);

      const fixed = source.slice(0, diagnostic.range.start) + "=>" + source.slice(diagnostic.range.end);
      const fixedResult = compileSourceWithUncheckedExterns(fixed.split("\n"));
      assert.deepStrictEqual(fixedResult.diagnostics, []);
      assert.ok(fixedResult.units.length > 0);
    }
  });
});

function itemSelectStatement(statement: ReturnType<typeof parseRsgl>["statements"][number]): ItemSelectStmtNode | undefined {
  if (statement.kind !== "ResourceDecl") {
    return undefined;
  }
  const candidate = statement.body.statements.find(item => item.kind === "ItemSelectStmt");
  return candidate?.kind === "ItemSelectStmt" ? candidate : undefined;
}
