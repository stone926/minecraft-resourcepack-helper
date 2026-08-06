import * as assert from "node:assert";
import * as path from "node:path";
import type { ExprNode } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import {
  type EvaluationContext,
  type EvaluationPathOrigin,
  type EvaluationValue,
  evaluateExpressionResult,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "../../src/compiler/evaluate";
import { compileSourceWithUncheckedExterns, unitByPath } from "./helpers/compile";

describe("RSGL collection evaluation origins", () => {
  it("uses mapper results from the same evaluation and preserves nested source origins", () => {
    let reads = 0;
    const source = ["first", "second"].map(value => {
      const item: Record<string, unknown> = {};
      Object.defineProperty(item, "value", {
        enumerable: true,
        get: () => {
          reads += 1;
          return value;
        }
      });
      return item;
    });
    const parsed = parseExpression(
      "map(source, item => ({ copied: item.value, fixed: \"helper\" }))"
    );
    const context = evaluationContext(
      parsed.fileName,
      new Map([["source", source as EvaluationValue]]),
      new Map([["source", [
        pathOrigin("/0/value", "data.rsgl", 10, 15),
        pathOrigin("/1/value", "data.rsgl", 30, 36)
      ]]])
    );

    const result = evaluateExpressionResult(parsed.expression, context);

    assert.deepStrictEqual(result.value, [
      { copied: "first", fixed: "helper" },
      { copied: "second", fixed: "helper" }
    ]);
    assert.strictEqual(reads, 2, "origin construction must not replay the mapper");
    assert.deepStrictEqual(originForEvaluationPath(result.pathOrigins, "/0/copied"), {
      sourceFile: "data.rsgl",
      sourceRange: { start: 10, end: 15 }
    });
    assert.deepStrictEqual(originForEvaluationPath(result.pathOrigins, "/1/copied"), {
      sourceFile: "data.rsgl",
      sourceRange: { start: 30, end: 36 }
    });
    const fixedOrigin = originForEvaluationPath(result.pathOrigins, "/1/fixed");
    assert.strictEqual(fixedOrigin?.sourceFile, parsed.fileName);
    assert.strictEqual(
      parsed.source.slice(fixedOrigin!.sourceRange.start, fixedOrigin!.sourceRange.end),
      "\"helper\""
    );
    const copiedRange = rangeForEvaluationPath(result.pathRanges, "/0/copied");
    assert.strictEqual(
      parsed.source.slice(copiedRange!.start, copiedRange!.end),
      "item.value"
    );
  });

  it("retains original filter items and offsets concat inputs", () => {
    const records = [
      { name: "first", keep: true },
      { name: "second", keep: false },
      { name: "third", keep: true }
    ];
    const filteredExpression = parseExpression("filter(records, item => item.keep)");
    const filtered = evaluateExpressionResult(
      filteredExpression.expression,
      evaluationContext(
        filteredExpression.fileName,
        new Map([["records", records]]),
        new Map([["records", [
          pathOrigin("/0/name", "records.rsgl", 1, 6),
          pathOrigin("/1/name", "records.rsgl", 11, 17),
          pathOrigin("/2/name", "records.rsgl", 21, 26)
        ]]])
      )
    );

    assert.deepStrictEqual(filtered.value, [records[0], records[2]]);
    assert.strictEqual(originForEvaluationPath(filtered.pathOrigins, "/0/name")?.sourceRange.start, 1);
    assert.strictEqual(originForEvaluationPath(filtered.pathOrigins, "/1/name")?.sourceRange.start, 21);

    const concatExpression = parseExpression("concat(left, right)");
    const concatenated = evaluateExpressionResult(
      concatExpression.expression,
      evaluationContext(
        concatExpression.fileName,
        new Map<string, EvaluationValue>([
          ["left", ["a", "b"]],
          ["right", ["c"]]
        ]),
        new Map([
          ["left", [
            pathOrigin("/0", "left.rsgl", 1, 2),
            pathOrigin("/1", "left.rsgl", 3, 4)
          ]],
          ["right", [pathOrigin("/0", "right.rsgl", 5, 6)]]
        ])
      )
    );

    assert.deepStrictEqual(concatenated.value, ["a", "b", "c"]);
    assert.strictEqual(originForEvaluationPath(concatenated.pathOrigins, "/0")?.sourceFile, "left.rsgl");
    assert.strictEqual(originForEvaluationPath(concatenated.pathOrigins, "/1")?.sourceRange.start, 3);
    assert.strictEqual(originForEvaluationPath(concatenated.pathOrigins, "/2")?.sourceFile, "right.rsgl");
  });

  it("preserves asList element origins for pass-through lists and scalar wrapping", () => {
    const source = ["first", "second"];
    const listExpression = parseExpression("asList(source)");
    const list = evaluateExpressionResult(
      listExpression.expression,
      evaluationContext(
        listExpression.fileName,
        new Map([["source", source]]),
        new Map([["source", [
          pathOrigin("/0", "list.rsgl", 1, 6),
          pathOrigin("/1", "list.rsgl", 8, 14)
        ]]])
      )
    );

    assert.strictEqual(list.value, source, "asList must retain the original list value");
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/0")?.sourceRange.start, 1);
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/1")?.sourceRange.start, 8);

    const scalarExpression = parseExpression("asList(source)");
    const scalar = evaluateExpressionResult(
      scalarExpression.expression,
      evaluationContext(
        scalarExpression.fileName,
        new Map([["source", "only"]]),
        new Map([["source", [pathOrigin("", "scalar.rsgl", 20, 24)]]])
      )
    );

    assert.deepStrictEqual(scalar.value, ["only"]);
    assert.deepStrictEqual(originForEvaluationPath(scalar.pathOrigins, "/0"), {
      sourceFile: "scalar.rsgl",
      sourceRange: { start: 20, end: 24 }
    });
  });

  it("copies spread paths and lets later object owners replace earlier origins", () => {
    const listExpression = parseExpression("[head, ...middle, tail]");
    const list = evaluateExpressionResult(
      listExpression.expression,
      evaluationContext(
        listExpression.fileName,
        new Map<string, EvaluationValue>([
          ["head", "h"],
          ["middle", ["m0", "m1"]],
          ["tail", "t"]
        ]),
        new Map([
          ["head", [pathOrigin("", "head.rsgl", 1, 2)]],
          ["middle", [
            pathOrigin("/0", "middle.rsgl", 10, 12),
            pathOrigin("/1", "middle.rsgl", 20, 22)
          ]],
          ["tail", [pathOrigin("", "tail.rsgl", 30, 31)]]
        ])
      )
    );

    assert.deepStrictEqual(list.value, ["h", "m0", "m1", "t"]);
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/0")?.sourceFile, "head.rsgl");
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/1")?.sourceRange.start, 10);
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/2")?.sourceRange.start, 20);
    assert.strictEqual(originForEvaluationPath(list.pathOrigins, "/3")?.sourceFile, "tail.rsgl");

    const objectExpression = parseExpression("{ ...base, shared: \"local\" }");
    const object = evaluateExpressionResult(
      objectExpression.expression,
      evaluationContext(
        objectExpression.fileName,
        new Map([["base", { baseOnly: 1, shared: "base" }]]),
        new Map([["base", [
          pathOrigin("/baseOnly", "base.rsgl", 1, 2),
          pathOrigin("/shared", "base.rsgl", 3, 4)
        ]]])
      )
    );
    const localOrigin = originForEvaluationPath(object.pathOrigins, "/shared");

    assert.deepStrictEqual(object.value, { baseOnly: 1, shared: "local" });
    assert.strictEqual(originForEvaluationPath(object.pathOrigins, "/baseOnly")?.sourceFile, "base.rsgl");
    assert.strictEqual(localOrigin?.sourceFile, objectExpression.fileName);
    assert.strictEqual(
      objectExpression.source.slice(localOrigin!.sourceRange.start, localOrigin!.sourceRange.end),
      "\"local\""
    );
  });

  it("uses the later mergeObjects field origin and product dimension-item origins", () => {
    const mergeExpression = parseExpression("mergeObjects(base, override)");
    const merged = evaluateExpressionResult(
      mergeExpression.expression,
      evaluationContext(
        mergeExpression.fileName,
        new Map<string, EvaluationValue>([
          ["base", { shared: "base", retained: true }],
          ["override", { shared: "override" }]
        ]),
        new Map([
          ["base", [
            pathOrigin("/shared", "base.rsgl", 1, 2),
            pathOrigin("/retained", "base.rsgl", 3, 4)
          ]],
          ["override", [pathOrigin("/shared", "override.rsgl", 8, 9)]]
        ])
      )
    );

    assert.strictEqual(originForEvaluationPath(merged.pathOrigins, "/shared")?.sourceFile, "override.rsgl");
    assert.strictEqual(originForEvaluationPath(merged.pathOrigins, "/retained")?.sourceFile, "base.rsgl");

    const productExpression = parseExpression("product(dimensions)");
    const product = evaluateExpressionResult(
      productExpression.expression,
      evaluationContext(
        productExpression.fileName,
        new Map([["dimensions", { row: [1, 2], column: ["a", "b"] }]]),
        new Map([["dimensions", [
          pathOrigin("/row/0", "dimensions.rsgl", 1, 2),
          pathOrigin("/row/1", "dimensions.rsgl", 3, 4),
          pathOrigin("/column/0", "dimensions.rsgl", 5, 6),
          pathOrigin("/column/1", "dimensions.rsgl", 7, 8)
        ]]])
      )
    );

    assert.strictEqual(originForEvaluationPath(product.pathOrigins, "/2/row")?.sourceRange.start, 3);
    assert.strictEqual(originForEvaluationPath(product.pathOrigins, "/3/column")?.sourceRange.start, 7);
  });

  it("carries collection path origins through the primary JSON resource sink", () => {
    const fileName = path.resolve("pack", "collection-origins.rsgl");
    const lines = [
      "let source = [{ value: \"first\" }, { value: \"second\" }]",
      "model block collection_origins {",
      "  merge {",
      "    mapped: map(source, item => ({ copied: item.value, fixed: \"helper\" }))",
      "  }",
      "}"
    ];
    const source = lines.join("\n");
    const result = compileSourceWithUncheckedExterns(lines, { fileName });
    const unit = unitByPath(result, "models/block/collection_origins.json");
    const origins = unit.validation?.referenceOrigins ?? [];
    const firstCopied = origins.find(origin => origin.generatedPath === "/mapped/0/copied");
    const secondCopied = origins.find(origin => origin.generatedPath === "/mapped/1/copied");
    const fixed = origins.find(origin => origin.generatedPath === "/mapped/0/fixed");

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(source.slice(firstCopied!.sourceRange.start, firstCopied!.sourceRange.end), "\"first\"");
    assert.strictEqual(source.slice(secondCopied!.sourceRange.start, secondCopied!.sourceRange.end), "\"second\"");
    assert.strictEqual(source.slice(fixed!.sourceRange.start, fixed!.sourceRange.end), "\"helper\"");
    assert.ok([firstCopied, secondCopied, fixed].every(origin => origin?.sourceFile === fileName));
  });
});

function parseExpression(expressionSource: string): {
  expression: ExprNode;
  source: string;
  fileName: string;
} {
  const source = `let result = ${expressionSource}`;
  const module = parseRsgl(source);
  const statement = module.statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected a let expression for '${expressionSource}'.`);
  }
  return {
    expression: statement.value,
    source,
    fileName: "origins.rsgl"
  };
}

function evaluationContext(
  sourceFile: string,
  variables: Map<string, EvaluationValue>,
  valuePathOrigins: Map<string, EvaluationPathOrigin[]>
): EvaluationContext {
  return {
    namespace: "minecraft",
    variables,
    valuePathOrigins,
    sourceFile
  };
}

function pathOrigin(
  generatedPath: string,
  sourceFile: string,
  start: number,
  end: number
): EvaluationPathOrigin {
  return {
    generatedPath,
    sourceFile,
    sourceRange: { start, end }
  };
}
