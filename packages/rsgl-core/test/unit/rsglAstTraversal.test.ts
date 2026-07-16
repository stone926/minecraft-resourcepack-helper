import * as assert from "node:assert";
import { parseRsgl, walkRsglModule } from "../../src/parser";

describe("RSGL AST traversal", () => {
  it("visits list and object spread children exactly once in source order", () => {
    const module = parseRsgl([
      "let combined = [head, ...middle, tail]",
      "let derived = { first: value, ...base, [key]: computed }"
    ].join("\n"));
    const visitedIdentifiers: string[] = [];
    const visitedKinds: string[] = [];

    assert.deepStrictEqual(module.diagnostics, []);
    walkRsglModule(module, {
      enterExpression(expression) {
        visitedKinds.push(expression.kind);
        if (expression.kind === "IdentifierExpr") {
          visitedIdentifiers.push(expression.name.text);
        }
      }
    });

    assert.deepStrictEqual(visitedIdentifiers, [
      "head",
      "middle",
      "tail",
      "value",
      "base",
      "key",
      "computed"
    ]);
    assert.strictEqual(visitedKinds.includes("ListSpread"), false);
    assert.strictEqual(visitedKinds.includes("ObjectSpread"), false);
  });

  it("visits transform angle, pivot, and nested model expressions in source order", () => {
    const module = parseRsgl([
      "model block minecraft:block/traversal {",
      "  transform rotate_y(quarter * angle) around pivot {",
      "    element from start to finish { north texture panelTexture }",
      "  }",
      "}"
    ].join("\n"));
    const statements: string[] = [];
    const identifiers: string[] = [];

    assert.deepStrictEqual(module.diagnostics, []);
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

    assert.deepStrictEqual(statements, ["ResourceDecl", "ModelTransformStmt", "ModelElementStmt"]);
    assert.deepStrictEqual(identifiers, ["quarter", "angle", "pivot", "start", "finish", "panelTexture"]);
  });

  it("visits every recursive item-model expression and option exactly once in source order", () => {
    const module = parseRsgl([
      "item traversal {",
      "  select property selector component componentName {",
      "    case matchValue => condition property conditionProperty {",
      "      on_true composite {",
      "        model leafValue with { tints: [tintValue] }",
      "        model use buildModel(argument: useValue)",
      "      } with { transformation: transformValue }",
      "      on_false range property rangeProperty period periodValue {",
      "        entry thresholdValue => entryValue with { tints: [entryTint] }",
      "        frames frameValues model frameValue with { tints: [frameTint] }",
      "        fallback fallbackValue",
      "      } with { transformation: rangeTransform }",
      "    } with { transformation: conditionTransform }",
      "    fallback rootFallback",
      "  } with { transformation: selectTransform }",
      "}"
    ].join("\n"));
    const statements: string[] = [];
    const identifiers: string[] = [];

    assert.deepStrictEqual(module.diagnostics, []);
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
      "ItemModelProducerStmt",
      "ItemSelectCase",
      "ItemCompositeModel",
      "ItemCompositeModel",
      "ItemRangeEntry",
      "ItemRangeFrames",
      "ItemFallbackClause",
      "ItemFallbackClause"
    ]);
    assert.deepStrictEqual(identifiers, [
      "traversal",
      "selector",
      "componentName",
      "matchValue",
      "conditionProperty",
      "leafValue",
      "tintValue",
      "buildModel",
      "useValue",
      "transformValue",
      "rangeProperty",
      "periodValue",
      "thresholdValue",
      "entryValue",
      "entryTint",
      "frameValues",
      "frameValue",
      "frameTint",
      "fallbackValue",
      "rangeTransform",
      "conditionTransform",
      "rootFallback",
      "selectTransform"
    ]);
  });
});
