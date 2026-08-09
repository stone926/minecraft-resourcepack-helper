import * as assert from "node:assert/strict";
import type { ResourceUnit, RsglCompileDiagnostic } from "../../src/compiler/ir";
import {
  asObject,
  isFiniteNumber,
  isNonNegativeInteger,
  isPositiveInteger,
  requireArray,
  requireBoolean,
  requireEnum,
  requireFiniteNumber,
  requireNumberInRange,
  requireObject,
  requirePositiveInteger,
  requirePositiveNumber,
  requireString,
  stripMinecraftPrefix
} from "../../src/compiler/validationPrimitives";

describe("RSGL validation primitives", () => {
  it("narrows valid values without emitting diagnostics", () => {
    const diagnostics: RsglCompileDiagnostic[] = [];
    const unit = createUnit();
    const issue = { code: "rsgl.invalid", message: "Invalid", generatedPath: "/nested/value" };

    assert.deepStrictEqual(requireObject({ value: 1 }, unit, diagnostics, issue), { value: 1 });
    assert.deepStrictEqual(requireArray([1], unit, diagnostics, issue), [1]);
    assert.strictEqual(requireString("value", unit, diagnostics, issue), "value");
    assert.strictEqual(requireBoolean(true, unit, diagnostics, issue), true);
    assert.strictEqual(requireFiniteNumber(1.5, unit, diagnostics, issue), 1.5);
    assert.strictEqual(requireNumberInRange(1, 0, 1, unit, diagnostics, issue), 1);
    assert.strictEqual(requirePositiveInteger(2, unit, diagnostics, issue), 2);
    assert.strictEqual(requirePositiveNumber(0.5, unit, diagnostics, issue), 0.5);
    assert.strictEqual(requireEnum("two", ["one", "two"], unit, diagnostics, issue), "two");
    assert.deepStrictEqual(diagnostics, []);
  });

  it("emits caller-defined diagnostics for invalid values", () => {
    const diagnostics: RsglCompileDiagnostic[] = [];
    const unit = createUnit();
    const invalidCases = [
      () => requireObject([], unit, diagnostics, issue("rsgl.object", "Object")),
      () => requireArray({}, unit, diagnostics, issue("rsgl.array", "Array")),
      () => requireString(1, unit, diagnostics, issue("rsgl.string", "String")),
      () => requireBoolean("true", unit, diagnostics, issue("rsgl.boolean", "Boolean")),
      () => requireFiniteNumber(Infinity, unit, diagnostics, issue("rsgl.finite", "Finite")),
      () => requireNumberInRange(2, 0, 1, unit, diagnostics, issue("rsgl.range", "Range")),
      () => requirePositiveInteger(0, unit, diagnostics, issue("rsgl.integer", "Integer")),
      () => requirePositiveNumber(-1, unit, diagnostics, issue("rsgl.number", "Number")),
      () => requireEnum("three", ["one", "two"], unit, diagnostics, issue("rsgl.enum", "Enum"))
    ];

    for (const validate of invalidCases) {
      assert.strictEqual(validate(), null);
    }

    assert.deepStrictEqual(diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      range: diagnostic.range
    })), [
      ["rsgl.object", "Object"],
      ["rsgl.array", "Array"],
      ["rsgl.string", "String"],
      ["rsgl.boolean", "Boolean"],
      ["rsgl.finite", "Finite"],
      ["rsgl.range", "Range"],
      ["rsgl.integer", "Integer"],
      ["rsgl.number", "Number"],
      ["rsgl.enum", "Enum"]
    ].map(([code, message]) => ({
      code,
      message,
      severity: "error",
      range: { start: 4, end: 5 }
    })));
  });

  it("normalizes Minecraft prefixes and shares numeric predicates", () => {
    assert.deepStrictEqual(asObject({ value: 1 }), { value: 1 });
    assert.strictEqual(asObject([]), null);
    assert.strictEqual(asObject(null), null);

    assert.strictEqual(stripMinecraftPrefix("minecraft:model"), "model");
    assert.strictEqual(stripMinecraftPrefix("example:model"), "example:model");
    assert.strictEqual(stripMinecraftPrefix(1), null);

    assert.strictEqual(isFiniteNumber(1.5), true);
    assert.strictEqual(isFiniteNumber(NaN), false);
    assert.strictEqual(isFiniteNumber(Infinity), false);
    assert.strictEqual(isPositiveInteger(1), true);
    assert.strictEqual(isPositiveInteger(0), false);
    assert.strictEqual(isPositiveInteger(1.5), false);
    assert.strictEqual(isNonNegativeInteger(0), true);
    assert.strictEqual(isNonNegativeInteger(-1), false);
  });
});

function issue(code: string, message: string) {
  return { code, message, generatedPath: "/nested/value" };
}

function createUnit(): ResourceUnit {
  return {
    kind: "model",
    outputPath: "assets/minecraft/models/example.json",
    content: {},
    mergePolicy: { kind: "replace" },
    sourceMap: {
      generatedFile: "assets/minecraft/models/example.json",
      mappings: [
        {
          generatedPath: "",
          sourceFile: "example.rsgl",
          sourceRange: { start: 1, end: 2 },
          reason: "direct",
          expansionStack: []
        },
        {
          generatedPath: "/nested/value",
          sourceFile: "example.rsgl",
          sourceRange: { start: 4, end: 5 },
          reason: "direct",
          expansionStack: []
        }
      ]
    }
  };
}
