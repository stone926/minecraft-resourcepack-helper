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
});
