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
});
