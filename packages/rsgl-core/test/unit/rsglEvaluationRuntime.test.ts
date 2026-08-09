import * as assert from "node:assert/strict";
import type { ExprNode } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import {
  type EvaluationContext,
  type EvaluationValue,
  evaluateExpression
} from "../../src/compiler/evaluate";
import { compileSource } from "./helpers/compile";

describe("RSGL runtime expression guards", () => {
  it("checks own-field presence without treating falsy values as missing", () => {
    const inherited = Object.create({ inherited: true }) as Record<string, EvaluationValue>;
    inherited.present = undefined;
    const context = evaluationContext(new Map([
      ["inherited", inherited as EvaluationValue]
    ]));

    assert.strictEqual(evaluate("has({ value: false }, \"value\")", context), true);
    assert.strictEqual(evaluate("has({ value: 0 }, \"value\")", context), true);
    assert.strictEqual(evaluate("has({ value: \"\" }, \"value\")", context), true);
    assert.strictEqual(evaluate("has({ value: false }, \"missing\")", context), false);
    assert.strictEqual(evaluate("has(1, \"value\")", context), false);
    assert.strictEqual(evaluate("has(inherited, \"present\")", context), true);
    assert.strictEqual(evaluate("has(inherited, \"inherited\")", context), false);
    assert.strictEqual(evaluate("has(key: \"value\", object: { value: false })", context), true);
  });

  it("evaluates each has argument exactly once", () => {
    let loads = 0;
    const context: EvaluationContext = {
      ...evaluationContext(),
      globLoader: () => {
        loads += 1;
        return ["one"];
      }
    };

    assert.strictEqual(evaluate("has(glob(\"*.json\"), \"length\")", context), false);
    assert.strictEqual(loads, 1);
  });

  it("reports dynamic list bounds and numeric index-shape failures", () => {
    const errors: Array<{ code: string; message: string; rangeText: string }> = [];
    const sourceFile = "runtime-index.rsgl";
    const variables = new Map<string, EvaluationValue>([
      ["values", ["first", "second"]],
      ["outside", 2],
      ["negative", -1],
      ["fractional", 0.5]
    ]);

    for (const indexName of ["outside", "negative", "fractional"]) {
      const source = `values[${indexName}]`;
      const document = `let result = ${source}`;
      const context: EvaluationContext = {
        ...evaluationContext(variables),
        sourceFile,
        onError: (code, message, range, fileName) => {
          assert.strictEqual(fileName, sourceFile);
          errors.push({ code, message, rangeText: document.slice(range.start, range.end) });
        }
      };
      assert.strictEqual(evaluate(source, context), undefined);
    }

    assert.deepStrictEqual(errors.map(error => error.code), [
      "rsgl.indexOutOfBounds",
      "rsgl.indexOutOfBounds",
      "rsgl.indexOutOfBounds"
    ]);
    assert.deepStrictEqual(errors.map(error => error.rangeText), ["outside", "negative", "fractional"]);
    assert.ok(errors[0].message.includes("bounds 0..1"));
    assert.ok(errors[1].message.includes("non-negative integer"));
    assert.ok(errors[2].message.includes("non-negative integer"));
  });

  it("leaves literal-list bounds diagnostics to semantic analysis", () => {
    const errors: string[] = [];
    const context: EvaluationContext = {
      ...evaluationContext(),
      onError: code => errors.push(code)
    };

    assert.strictEqual(evaluate("[1, 2][4]", context), undefined);
    assert.deepStrictEqual(errors, []);
  });

  it("emits exactly one compiler diagnostic for static and dynamic bounds failures", () => {
    const dynamic = compileSource([
      "let values = [1, 2]",
      "let index = 2",
      "model block dynamic_index { merge { selected: values[index] } }"
    ]);
    const staticResult = compileSource([
      "model block static_index { merge { selected: [1, 2][4] } }"
    ]);

    assert.deepStrictEqual(dynamic.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.indexOutOfBounds"
    ]);
    assert.ok(dynamic.diagnostics[0].message.includes("runtime list bounds"));
    assert.deepStrictEqual(staticResult.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.indexOutOfBounds"
    ]);
    assert.ok(staticResult.diagnostics[0].message.includes("static list bounds"));
  });

  it("uses runtime bounds for lists whose spread changes the AST element count", () => {
    const valid = compileSource([
      "let values = [1, 2]",
      "json \"assets/minecraft/spread-literal.json\" { selected [...[1, 2]][1] }",
      "json \"assets/minecraft/spread-binding.json\" { selected [...values][1] }"
    ]);
    const invalid = compileSource([
      "json \"assets/minecraft/spread-invalid.json\" { selected [...[1, 2]][2] }"
    ]);

    assert.deepStrictEqual(valid.diagnostics, []);
    assert.deepStrictEqual(valid.units.map(unit => unit.content), [
      { selected: 2 },
      { selected: 2 }
    ]);
    assert.deepStrictEqual(invalid.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.indexOutOfBounds"
    ]);
    assert.ok(invalid.diagnostics[0].message.includes("runtime list bounds"));
  });
});

function evaluate(source: string, context: EvaluationContext): EvaluationValue {
  return evaluateExpression(parseExpression(source), context);
}

function parseExpression(source: string): ExprNode {
  const module = parseRsgl(`let result = ${source}`);
  const statement = module.statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected a let expression for '${source}'.`);
  }
  return statement.value;
}

function evaluationContext(
  variables: Map<string, EvaluationValue> = new Map()
): EvaluationContext {
  return {
    namespace: "minecraft",
    variables
  };
}
