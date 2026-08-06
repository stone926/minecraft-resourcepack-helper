import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExprNode } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import { compileRsglProgram } from "../../src/compiler";
import {
  type EvaluationContext,
  type EvaluationValue,
  evaluateExpression
} from "../../src/compiler/evaluate";
import { EvaluationItemBudget } from "../../src/compiler/evaluationItemBudget";
import {
  compileSourceWithUncheckedExterns,
  generatedResourceUnits,
  withUncheckedExterns
} from "./helpers/compile";
import { withTempDir } from "./helpers/fs";

describe("RSGL collection runtime", () => {
  it("canonicalizes overlapping semantic and runtime collection diagnostics", () => {
    for (const [source, code] of [
      ["let invalid = [...1]", "rsgl.invalidListSpread"],
      ["let invalid = { ...true }", "rsgl.invalidObjectSpread"],
      ["let invalid = filter([1], value => value)", "rsgl.predicateMustReturnBoolean"],
      ["let invalid = flatMap([1], value => value)", "rsgl.mapperReturnTypeMismatch"]
    ] as const) {
      const result = compileSourceWithUncheckedExterns([source]);
      assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [code], source);
    }
  });

  it("preserves collection order and uses shallow, later-wins object merging", () => {
    const context = evaluationContext();

    assert.deepStrictEqual(evaluate("map([1, 2, 3], value => value * 2)", context), [2, 4, 6]);
    assert.deepStrictEqual(evaluate("filter([1, 2, 3, 4], value => value % 2 == 0)", context), [2, 4]);
    assert.deepStrictEqual(evaluate("flatMap([1, 2], value => [value, value + 10])", context), [1, 11, 2, 12]);
    assert.deepStrictEqual(evaluate("concat([1, 2], [], [3], [4, 5])", context), [1, 2, 3, 4, 5]);
    assert.strictEqual(evaluate("join([\"one\", \"two\", \"three\"], \"|\")", context), "one|two|three");
    assert.deepStrictEqual(
      evaluate("mergeObjects({ nested: { left: true }, first: 1 }, { nested: { right: true }, second: 2 })", context),
      { nested: { right: true }, first: 1, second: 2 }
    );
  });

  it("keeps asList pass-through work free, charges scalar wrapping, and evaluates length in O(1)", () => {
    const source = [1, 2, 3];
    const passThroughErrors: string[] = [];
    const passThroughContext = evaluationContext(
      new Map([["source", source as EvaluationValue]]),
      0,
      passThroughErrors
    );

    assert.strictEqual(evaluate("asList(source)", passThroughContext), source);
    assert.strictEqual(evaluate("length(source)", passThroughContext), 3);
    assert.strictEqual(passThroughContext.evaluationItemBudget?.consumed, 0);
    assert.deepStrictEqual(passThroughErrors, []);

    const rangeContext = evaluationContext(new Map(), 3);
    assert.deepStrictEqual(evaluate("asList(0..2)", rangeContext), [0, 1, 2]);
    assert.strictEqual(
      rangeContext.evaluationItemBudget?.consumed,
      3,
      "asList must not charge a materialized Range twice"
    );

    const scalarErrors: string[] = [];
    const rejectedScalarContext = evaluationContext(new Map(), 0, scalarErrors);
    assert.strictEqual(evaluate("asList(1)", rejectedScalarContext), undefined);
    assert.deepStrictEqual(scalarErrors, ["rsgl.collectionExpansionLimit"]);

    const scalarContext = evaluationContext(new Map(), 1);
    assert.deepStrictEqual(evaluate("asList(1)", scalarContext), [1]);
    assert.strictEqual(scalarContext.evaluationItemBudget?.consumed, 1);
  });

  it("rejects scalar length inputs at runtime", () => {
    for (const source of ["length(\"abc\")", "length({ value: 1 })"]) {
      const errors: string[] = [];
      assert.strictEqual(evaluate(source, evaluationContext(new Map(), 1, errors)), undefined);
      assert.deepStrictEqual(errors, ["rsgl.collectionExpected"], source);
    }
  });

  it("rejects non-scalar asList inputs at runtime", () => {
    const errors: string[] = [];
    assert.strictEqual(
      evaluate("asList({ value: 1 })", evaluationContext(new Map(), 1, errors)),
      undefined
    );
    assert.deepStrictEqual(errors, ["rsgl.collectionExpected"]);
  });

  it("keeps object insertion order and omits absent optional fields", () => {
    const record = { first: 1, third: 3 };
    const context = evaluationContext(new Map([
      ["record", record as EvaluationValue]
    ]));

    assert.deepStrictEqual(evaluate("keys(record)", context), ["first", "third"]);
    assert.deepStrictEqual(evaluate("values(record)", context), [1, 3]);
    assert.deepStrictEqual(evaluate("entries(record)", context), [
      { key: "first", value: 1 },
      { key: "third", value: 3 }
    ]);
  });

  it("evaluates every mapper and predicate exactly once per visited item", () => {
    let mapReads = 0;
    let filterReads = 0;
    let flatMapReads = 0;
    const source = [1, 2, 3].map(value => {
      const item: Record<string, unknown> = {};
      Object.defineProperties(item, {
        mapped: {
          enumerable: true,
          get: () => {
            mapReads += 1;
            return value * 2;
          }
        },
        keep: {
          enumerable: true,
          get: () => {
            filterReads += 1;
            return value !== 2;
          }
        },
        expanded: {
          enumerable: true,
          get: () => {
            flatMapReads += 1;
            return [value, -value];
          }
        }
      });
      return item;
    });
    const context = evaluationContext(new Map([
      ["source", source as EvaluationValue]
    ]));

    assert.deepStrictEqual(evaluate("map(source, item => item.mapped)", context), [2, 4, 6]);
    assert.deepStrictEqual(evaluate("filter(source, item => item.keep)", context), [source[0], source[2]]);
    assert.deepStrictEqual(evaluate("flatMap(source, item => item.expanded)", context), [1, -1, 2, -2, 3, -3]);
    assert.deepStrictEqual({ mapReads, filterReads, flatMapReads }, {
      mapReads: 3,
      filterReads: 3,
      flatMapReads: 3
    });
  });

  it("rejects truthy predicates, non-iterable flatMap results, and named rest arguments", () => {
    const errors: string[] = [];
    let failures = 0;
    const context: EvaluationContext = {
      ...evaluationContext(),
      onError: code => errors.push(code),
      onEvaluationFailure: () => {
        failures += 1;
      }
    };

    assert.strictEqual(evaluate("filter([1], value => \"yes\")", context), undefined);
    assert.strictEqual(evaluate("flatMap([1], value => value)", context), undefined);
    assert.strictEqual(evaluate("concat(sources: [1, 2])", context), undefined);
    assert.deepStrictEqual(errors, [
      "rsgl.predicateMustReturnBoolean",
      "rsgl.mapperReturnTypeMismatch"
    ]);
    assert.ok(failures >= 3);
  });

  it("supports list/object spread and protects prototype-named JSON keys", () => {
    const context = evaluationContext();
    const list = evaluate("[0, ...[1, 2], 3, ...[]]", context);
    const object = evaluate(
      "{ first: 1, ...{ second: 2, shared: \"base\" }, shared: \"local\", ...{ third: 3 } }",
      context
    );
    const protectedObject = evaluate(
      "mergeObjects({ \"__proto__\": { polluted: true } }, { safe: true })",
      context
    );

    assert.deepStrictEqual(list, [0, 1, 2, 3]);
    assert.deepStrictEqual(object, { first: 1, second: 2, shared: "local", third: 3 });
    assert.ok(protectedObject && typeof protectedObject === "object" && !Array.isArray(protectedObject));
    assert.strictEqual(Object.hasOwn(protectedObject as object, "__proto__"), true);
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("retains empty keys and RSGL insertion order for integer-like keys", () => {
    const context = evaluationContext();
    const declared = "{ \"10\": \"ten\", \"2\": \"two\", z: \"zed\" }";

    assert.deepStrictEqual(evaluate(`keys(${declared})`, context), ["10", "2", "z"]);
    assert.deepStrictEqual(evaluate(`values(${declared})`, context), ["ten", "two", "zed"]);
    assert.deepStrictEqual(evaluate(`entries(${declared})`, context), [
      { key: "10", value: "ten" },
      { key: "2", value: "two" },
      { key: "z", value: "zed" }
    ]);
    assert.deepStrictEqual(
      evaluate(`keys({ ...${declared}, "1": "one" })`, context),
      ["10", "2", "z", "1"]
    );
    assert.deepStrictEqual(
      evaluate(`keys(mergeObjects(${declared}, { "1": "one" }))`, context),
      ["10", "2", "z", "1"]
    );
    assert.deepStrictEqual(
      evaluate(
        "map(product({ \"10\": [1], \"2\": [2] }), item => keys(item))",
        context
      ),
      [["10", "2"]]
    );

    const emptyKey = evaluate("{ [\"\"]: 1, normal: 2 }", context);
    assert.ok(emptyKey && typeof emptyKey === "object" && !Array.isArray(emptyKey));
    assert.strictEqual(Object.hasOwn(emptyKey as object, ""), true);
    assert.strictEqual((emptyKey as Record<string, EvaluationValue>)[""], 1);
  });

  it("rejects non-plain runtime objects from record collection operations", () => {
    const injected = new (class RuntimeObject {
      public value = 1;
    })();
    for (const [source, code] of [
      ["mergeObjects(injected)", "rsgl.collectionExpected"],
      ["{ ...injected }", "rsgl.invalidObjectSpread"],
      ["keys(injected)", "rsgl.collectionExpected"],
      ["product(injected)", "rsgl.collectionExpected"]
    ] as const) {
      const errors: string[] = [];
      const context = evaluationContext(
        new Map([["injected", injected as unknown as EvaluationValue]]),
        100_000,
        errors
      );
      assert.strictEqual(evaluate(source, context), undefined, source);
      assert.deepStrictEqual(errors, [code], source);
    }
  });

  it("does not attach object value failures to keys", () => {
    const keysResult = compileSourceWithUncheckedExterns([
      "let bad: (Number) -> Number = value => value",
      "json \"assets/minecraft/keys.json\" {",
      "  out keys({ bad: bad })",
      "}"
    ]);
    assert.deepStrictEqual(keysResult.diagnostics, []);
    assert.deepStrictEqual(generatedResourceUnits(keysResult)[0]?.content, { out: ["bad"] });

    const entriesResult = compileSourceWithUncheckedExterns([
      "let bad: (Number) -> Number = value => value",
      "json \"assets/minecraft/entries.json\" {",
      "  out entries({ bad: bad })",
      "}"
    ]);
    assert.deepStrictEqual(
      entriesResult.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.functionValueNotSerializable"]
    );
    assert.ok(entriesResult.diagnostics[0].message.includes("'/out/0/value'"));
    assert.deepStrictEqual(generatedResourceUnits(entriesResult), []);
  });

  it("keeps product in stable cartesian order", () => {
    assert.deepStrictEqual(
      evaluate("product({ row: [1, 2], column: [\"a\", \"b\"] })", evaluationContext()),
      [
        { row: 1, column: "a" },
        { row: 1, column: "b" },
        { row: 2, column: "a" },
        { row: 2, column: "b" }
      ]
    );
  });
});

describe("RSGL collection evaluation budget", () => {
  it("does not re-evaluate direct top-level collection bindings in the compiler pass", () => {
    const result = compileSourceWithUncheckedExterns([
      "let values = map([1, 2], value => value)",
      "json \"assets/minecraft/collection-once.json\" {",
      "  values values",
      "}"
    ], { maxEvaluationItems: 3 });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(result.units.find(unit =>
      unit.outputPath.endsWith("collection-once.json")
    )?.content, { values: [1, 2] });
  });

  it("checks fixed-size work before invoking map/filter callbacks", () => {
    let reads = 0;
    const item: Record<string, unknown> = {};
    Object.defineProperty(item, "value", {
      enumerable: true,
      get: () => {
        reads += 1;
        return true;
      }
    });
    const errors: string[] = [];
    const context = evaluationContext(
      new Map([["source", [item, item, item] as EvaluationValue]]),
      2,
      errors
    );

    assert.strictEqual(evaluate("map(source, entry => entry.value)", context), undefined);
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(errors, ["rsgl.collectionExpansionLimit"]);
  });

  it("bounds range, seq, flatMap, product, and spread before large allocation", () => {
    const cases = [
      "0..1000000000",
      "seq(\"{0..1000000000}\")",
      "flatMap([1, 2], value => [value, value])",
      "product({ left: [1, 2], right: [3, 4] })",
      "[...[1, 2, 3, 4]]"
    ];

    for (const source of cases) {
      const errors: string[] = [];
      const context = evaluationContext(new Map(), 3, errors);
      assert.strictEqual(evaluate(source, context), undefined, source);
      assert.deepStrictEqual(errors, ["rsgl.collectionExpansionLimit"], source);
    }
  });

  it("suppresses collection-shape cascades after an upstream expansion failure", () => {
    for (const source of ["concat(0..100)", "[...(0..100)]"]) {
      const errors: string[] = [];
      const context = evaluationContext(new Map(), 3, errors);
      assert.strictEqual(evaluate(source, context), undefined, source);
      assert.deepStrictEqual(errors, ["rsgl.collectionExpansionLimit"], source);
    }
  });

  it("keeps a hard per-allocation guard even with an unsafe project-sized budget", () => {
    const errors: string[] = [];
    const context = evaluationContext(new Map(), Number.MAX_SAFE_INTEGER, errors);

    assert.strictEqual(evaluate("0..10000001", context), undefined);
    assert.deepStrictEqual(errors, ["rsgl.collectionExpansionLimit"]);
  });

  it("shares accounting across sibling evaluations while join emits no collection items", () => {
    const errors: string[] = [];
    const context = evaluationContext(new Map(), 2, errors);

    assert.strictEqual(evaluate("join([\"a\", \"b\"], \"\")", context), "ab");
    assert.deepStrictEqual(evaluate("concat([1], [2])", context), [1, 2]);
    assert.strictEqual(evaluate("entries({ third: 3 })", context), undefined);
    assert.deepStrictEqual(errors, ["rsgl.collectionExpansionLimit"]);
  });

  it("enforces maxEvaluationItems through the compile pipeline", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block budgeted {",
      "  merge { values: concat([1, 2], [3]) }",
      "}"
    ], { maxEvaluationItems: 2 });

    assert.strictEqual(
      result.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.collectionExpansionLimit").length,
      1
    );
    assert.deepStrictEqual(result.units, []);
  });

  it("rolls back resources when collection evaluation fails without loop cascades", () => {
    const loopExpressions = [
      "product({ a: [1, 2], b: [3, 4] })",
      "0..100"
    ];

    for (const expression of loopExpressions) {
      const result = compileSourceWithUncheckedExterns([
        "model block loop_budget {",
        `  for row in ${expression} {`,
        "    merge { values: [row] }",
        "  }",
        "}"
      ], { maxEvaluationItems: 3 });

      assert.deepStrictEqual(
        result.diagnostics.map(diagnostic => diagnostic.code),
        ["rsgl.collectionExpansionLimit"],
        expression
      );
      assert.deepStrictEqual(generatedResourceUnits(result), [], expression);
    }

    const particles = compileSourceWithUncheckedExterns([
      "particles budgeted {",
      "  use particlesSeq(\"minecraft:p_{0..100}\")",
      "}"
    ], { maxEvaluationItems: 3 });

    assert.deepStrictEqual(
      particles.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.collectionExpansionLimit"]
    );
    assert.deepStrictEqual(generatedResourceUnits(particles), []);
  });

  it("does not charge an entry compile for unreachable module environments", () => {
    const root = path.resolve("collection-budget-entry-closure");
    const mainFile = path.join(root, "main.rsgl");
    const unusedFile = path.join(root, "unused.rsgl");
    const main = {
      fileName: mainFile,
      module: parseRsgl([
        "model block main {",
        "  values map([1, 2], value => value)",
        "}"
      ].join("\n"))
    };
    const options = withUncheckedExterns({
      entryFileName: mainFile,
      maxEvaluationItems: 3
    });
    const baseline = compileRsglProgram([main], options);
    const withUnused = compileRsglProgram([
      main,
      {
        fileName: unusedFile,
        module: parseRsgl("let waste = map([1, 2, 3], value => value)")
      }
    ], options);

    assert.deepStrictEqual(baseline.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(withUnused.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.deepStrictEqual(
      generatedResourceUnits(withUnused).map(unit => [unit.outputPath, unit.content]),
      generatedResourceUnits(baseline).map(unit => [unit.outputPath, unit.content])
    );
  });

  it("bounds filesystem glob enumeration before materializing over-budget matches", () => {
    withTempDir(root => {
      const matchesDirectory = path.join(root, "matches");
      fs.mkdirSync(matchesDirectory);
      for (let index = 0; index < 4; index++) {
        fs.writeFileSync(path.join(matchesDirectory, `${index}.json`), "{}", "utf8");
      }

      const result = compileSourceWithUncheckedExterns([
        "json \"assets/minecraft/glob-budget.json\" {",
        "  files glob(\"./matches/*.json\")",
        "}"
      ], {
        fileName: path.join(root, "main.rsgl"),
        maxEvaluationItems: 3
      });

      assert.deepStrictEqual(
        result.diagnostics.map(diagnostic => diagnostic.code),
        ["rsgl.collectionExpansionLimit"]
      );
      assert.deepStrictEqual(generatedResourceUnits(result), []);
    });
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
  variables: Map<string, EvaluationValue> = new Map(),
  maxItems = 100_000,
  errors?: string[]
): EvaluationContext {
  return {
    namespace: "minecraft",
    variables,
    evaluationItemBudget: new EvaluationItemBudget(maxItems),
    onError: errors ? code => errors.push(code) : undefined
  };
}
