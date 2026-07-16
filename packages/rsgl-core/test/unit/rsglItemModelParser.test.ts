import * as assert from "node:assert";
import {
  parseRsgl,
  type ItemModelProducerStmtNode,
  type ResourceDeclNode,
  type TemplateDeclNode
} from "../../src/parser";

describe("RSGL recursive item-model parser", () => {
  it("parses recursive nodes, item_model templates, value use, and postfix options", () => {
    const module = parseRsgl([
      "template variant(baseModel: ModelId) -> item_model {",
      "  first_match {",
      "    when property minecraft:component predicate \"enchantments\" value [{ enchantments: minecraft:loyalty }] =>",
      "      condition property minecraft:using_item {",
      "        on_true baseModel with { tints: [{ type: minecraft:constant, value: -1 }] }",
      "        on_false empty {}",
      "      } with { transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }",
      "    fallback use common.itemModel(baseModel: baseModel)",
      "  } with { transformation: { translation: [0, 1, 0] } }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const template = module.statements[0] as TemplateDeclNode;
    assert.strictEqual(template.declaredOutputDialect, "item_model");
    assert.strictEqual(template.body.kind, "ItemModelTemplateBody");
    if (template.body.kind !== "ItemModelTemplateBody") {
      assert.fail("Expected item_model template body.");
    }
    const producer = template.body.statements[0];
    assert.strictEqual(producer.kind, "ItemModelProducerStmt");
    if (producer.kind !== "ItemModelProducerStmt" || producer.value.kind !== "ItemModelFirstMatch") {
      assert.fail("Expected first_match producer.");
    }
    assert.strictEqual(producer.value.options?.kind, "ObjectExpr");
    const [when, fallback] = producer.value.body.statements;
    assert.strictEqual(when.kind, "ItemFirstMatchWhen");
    assert.strictEqual(fallback.kind, "ItemFallbackClause");
    if (when.kind !== "ItemFirstMatchWhen" || fallback.kind !== "ItemFallbackClause") {
      assert.fail("Expected first_match clauses.");
    }
    assert.deepStrictEqual(when.propertyOptions.map(option => option.name.text), ["predicate", "value"]);
    assert.strictEqual(when.model.kind, "ItemModelCondition");
    assert.strictEqual(fallback.model.kind, "ItemModelUse");
    if (when.model.kind === "ItemModelCondition") {
      assert.strictEqual(when.model.onTrue?.kind, "ItemModelExpr");
      assert.strictEqual(when.model.onFalse?.kind, "ItemModelEmpty");
      assert.strictEqual(when.model.options?.kind, "ObjectExpr");
    }
  });

  it("preserves typed owner bodies through control flow and parses ordered range clauses", () => {
    const module = parseRsgl([
      "item clock {",
      "  range property minecraft:time source daytime {",
      "    entry 0 => minecraft:item/clock_00",
      "    frames 0..1 model composite {",
      "      let overlay = minecraft:item/clock_overlay",
      "      model minecraft:item/clock_base",
      "      if true { model overlay with { tints: [] } }",
      "    }",
      "    frames [2, 3] model use common.clockFrame(frame: frame, index: index)",
      "    fallback selected_item {}",
      "  }",
      "}",
      "item potion {",
      "  select property minecraft:component component minecraft:potion_contents {",
      "    for potion in potions {",
      "      case [{ potion: potion.id }] => potion.model",
      "    }",
      "    fallback minecraft:item/potion",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const range = itemProducer(module.statements[0]);
    assert.strictEqual(range.value.kind, "ItemModelRange");
    if (range.value.kind !== "ItemModelRange") {
      assert.fail("Expected range producer.");
    }
    assert.deepStrictEqual(
      range.value.body.statements.map(statement => statement.kind),
      ["ItemRangeEntry", "ItemRangeFrames", "ItemRangeFrames", "ItemFallbackClause"]
    );
    const firstFrames = range.value.body.statements[1];
    assert.strictEqual(firstFrames.kind, "ItemRangeFrames");
    if (firstFrames.kind === "ItemRangeFrames" && firstFrames.model.kind === "ItemModelComposite") {
      assert.deepStrictEqual(
        firstFrames.model.body.statements.map(statement => statement.kind),
        ["LetDecl", "ItemCompositeModel", "IfStmt"]
      );
      const nestedIf = firstFrames.model.body.statements[2];
      assert.strictEqual(nestedIf.kind === "IfStmt" ? nestedIf.thenBody.kind : undefined, "ItemCompositeBody");
    } else {
      assert.fail("Expected recursive composite frames model.");
    }

    const select = itemProducer(module.statements[1]);
    assert.strictEqual(select.value.kind, "ItemModelSelect");
    if (select.value.kind === "ItemModelSelect") {
      const loop = select.value.body.statements[0];
      assert.strictEqual(loop.kind, "ForStmt");
      assert.strictEqual(loop.kind === "ForStmt" ? loop.body.kind : undefined, "ItemSelectBody");
    }
  });

  it("uses contextual lookahead while preserving explicit properties and identifier expressions", () => {
    const module = parseRsgl([
      "item names {",
      "  select: select",
      "  range = range",
      "  condition conditionValue",
      "  composite compositeValue",
      "  special specialValue",
      "  first_match firstMatchValue",
      "  model empty",
      "}",
      "item nested_names {",
      "  select property minecraft:display_context {",
      "    case gui => empty",
      "    fallback select",
      "  }",
      "}",
      "item contextual_header {",
      "  condition property predicate predicate value value [] {",
      "    on_true empty {}",
      "    on_false selected_item {}",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const names = module.statements[0] as ResourceDeclNode;
    assert.deepStrictEqual(
      names.body.statements.map(statement => statement.kind),
      [
        "PropertyStmt",
        "PropertyStmt",
        "PropertyStmt",
        "PropertyStmt",
        "PropertyStmt",
        "PropertyStmt",
        "ItemModelProducerStmt"
      ]
    );
    const modelProducer = names.body.statements[6];
    assert.strictEqual(
      modelProducer.kind === "ItemModelProducerStmt" && modelProducer.value.kind === "ItemModelExpr"
        ? modelProducer.value.expression.kind
        : undefined,
      "IdentifierExpr"
    );

    const nested = itemProducer(module.statements[1]);
    if (nested.value.kind !== "ItemModelSelect") {
      assert.fail("Expected select producer.");
    }
    for (const clause of nested.value.body.statements) {
      if (clause.kind === "ItemSelectCase" || clause.kind === "ItemFallbackClause") {
        assert.strictEqual(clause.model.kind, "ItemModelExpr");
      }
    }

    const contextualHeader = itemProducer(module.statements[2]);
    assert.strictEqual(contextualHeader.value.kind, "ItemModelCondition");
    if (contextualHeader.value.kind === "ItemModelCondition") {
      assert.strictEqual(contextualHeader.value.property.kind, "IdentifierExpr");
      assert.deepStrictEqual(
        contextualHeader.value.propertyOptions.map(option => [option.name.text, option.value.kind]),
        [["predicate", "IdentifierExpr"], ["value", "ListExpr"]]
      );
    }
  });

  it("keeps contextual option words inside complete header expressions", () => {
    const module = parseRsgl([
      "item contextual_operands {",
      "  condition property prefix + component",
      "    component resolve(component, predicate)",
      "    predicate optionPrefix + value",
      "    value [component, predicate, value] {",
      "      on_true empty {}",
      "      on_false selected_item {}",
      "    }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const producer = itemProducer(module.statements[0]);
    assert.strictEqual(producer.value.kind, "ItemModelCondition");
    if (producer.value.kind !== "ItemModelCondition") {
      assert.fail("Expected condition producer.");
    }

    assert.strictEqual(producer.value.property.kind, "BinaryExpr");
    if (producer.value.property.kind === "BinaryExpr") {
      assert.strictEqual(producer.value.property.operator, "+");
      assert.strictEqual(
        producer.value.property.right.kind === "IdentifierExpr"
          ? producer.value.property.right.name.text
          : undefined,
        "component"
      );
    }

    assert.deepStrictEqual(
      producer.value.propertyOptions.map(option => option.name.text),
      ["component", "predicate", "value"]
    );
    const [componentOption, predicateOption, valueOption] = producer.value.propertyOptions;
    assert.strictEqual(componentOption.value.kind, "CallExpr");
    if (componentOption.value.kind === "CallExpr") {
      assert.deepStrictEqual(
        componentOption.value.args.map(argument =>
          argument.value.kind === "IdentifierExpr" ? argument.value.name.text : undefined
        ),
        ["component", "predicate"]
      );
    }
    assert.strictEqual(predicateOption.value.kind, "BinaryExpr");
    if (predicateOption.value.kind === "BinaryExpr") {
      assert.strictEqual(
        predicateOption.value.right.kind === "IdentifierExpr"
          ? predicateOption.value.right.name.text
          : undefined,
        "value"
      );
    }
    assert.strictEqual(valueOption.value.kind, "ListExpr");
    if (valueOption.value.kind === "ListExpr") {
      assert.deepStrictEqual(
        valueOption.value.elements.map(element =>
          element.kind === "IdentifierExpr" ? element.name.text : undefined
        ),
        ["component", "predicate", "value"]
      );
    }
  });

  it("recovers a missing header operand without losing the condition body", () => {
    const module = parseRsgl([
      "item recovered_header {",
      "  condition property prefix + {",
      "    on_true empty {}",
      "    on_false selected_item {}",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(
      module.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.expectedExpression"]
    );
    const producer = itemProducer(module.statements[0]);
    assert.strictEqual(producer.value.kind, "ItemModelCondition");
    if (producer.value.kind === "ItemModelCondition") {
      assert.strictEqual(producer.value.property.kind, "BinaryExpr");
      assert.strictEqual(producer.value.onTrue?.kind, "ItemModelEmpty");
      assert.strictEqual(producer.value.onFalse?.kind, "ItemModelSelectedItem");
    }
  });

  it("accepts canonical terminal braces while retaining legacy bare terminals at item roots", () => {
    const module = parseRsgl([
      "item legacy_empty { empty }",
      "item canonical_empty { empty {} }",
      "item legacy_selected { selected_item }",
      "item canonical_selected { selected_item {} }"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(
      module.statements.map(statement => itemProducer(statement).value.kind),
      ["ItemModelEmpty", "ItemModelEmpty", "ItemModelSelectedItem", "ItemModelSelectedItem"]
    );
  });

  it("rejects caller-side options consistently on root and nested item_model template calls", () => {
    const module = parseRsgl([
      "template bad() -> item_model {",
      "  use common.build() with { transformation: templateTransform }",
      "}",
      "item root_call {",
      "  use common.build() with { transformation: rootTransform }",
      "}",
      "item nested_call {",
      "  composite {",
      "    model use common.build() with { transformation: nestedTransform }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(
      module.diagnostics.map(diagnostic => diagnostic.code),
      [
        "rsgl.itemModelOptionsNotSupported",
        "rsgl.itemModelOptionsNotSupported",
        "rsgl.itemModelOptionsNotSupported"
      ]
    );
    const template = module.statements[0];
    assert.strictEqual(
      template.kind === "TemplateDecl" && template.body.kind === "ItemModelTemplateBody"
        ? template.body.statements[0]?.kind
        : undefined,
      "UseDecl"
    );
    const root = module.statements[1];
    assert.strictEqual(
      root.kind === "ResourceDecl" ? root.body.statements[0]?.kind : undefined,
      "UseDecl"
    );
    const nested = itemProducer(module.statements[2]);
    assert.strictEqual(nested.value.kind, "ItemModelComposite");
  });
});

function itemProducer(statement: ReturnType<typeof parseRsgl>["statements"][number]): ItemModelProducerStmtNode {
  assert.strictEqual(statement.kind, "ResourceDecl");
  if (statement.kind !== "ResourceDecl") {
    throw new Error("Expected item resource declaration.");
  }
  for (const candidate of statement.body.statements) {
    if (candidate.kind === "ItemModelProducerStmt") {
      return candidate;
    }
  }
  assert.fail("Expected item-model producer.");
}
