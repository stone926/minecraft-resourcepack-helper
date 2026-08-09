import * as assert from "node:assert/strict";
import type { ExprNode } from "../../src/parser";
import { parseRsgl } from "../../src/parser";
import type { EvaluationContext, EvaluationValue } from "../../src/compiler/evaluate";
import { stableJsonStringify } from "../../src/compiler/emit";
import type { JsonValue } from "../../src/compiler/ir";
import { evaluateJsonExpression } from "../../src/compiler/jsonValueLowerer";
import { ModuleNamespaceValue } from "../../src/compiler/moduleNamespaceValue";
import { compileSource, expectNoDiagnostics } from "./helpers/compile";

describe("RSGL JSON value lowering", () => {
  it("rejects a direct function value and drops only its resource unit", () => {
    const source = [
      "model block invalid_function { callback (() => 1) }",
      "model block valid_neighbor { enabled true }"
    ].join("\n");
    const result = compileSource(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.functionValueNotSerializable"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "() => 1");
    assert.ok(diagnostic.message.includes("'/callback'"));
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath), [
      "assets/minecraft/models/block/valid_neighbor.json"
    ]);
    assert.deepStrictEqual(result.units[0].content, { enabled: true });
  });

  it("rejects functions nested in objects and lists at their JSON paths", () => {
    const source = [
      "json \"assets/example/object.json\" {",
      "  merge { outer: { callback: (() => 1) } }",
      "}",
      "json \"assets/example/list.json\" {",
      "  merge { entries: [{ callback: (() => 2) }] }",
      "}"
    ].join("\n");
    const result = compileSource(source.split("\n"));
    const diagnostics = result.diagnostics.filter(item =>
      item.code === "rsgl.functionValueNotSerializable"
    );

    assert.strictEqual(diagnostics.length, 2);
    assert.deepStrictEqual(
      diagnostics.map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end)),
      ["() => 1", "() => 2"]
    );
    assert.ok(diagnostics[0].message.includes("'/outer/callback'"));
    assert.ok(diagnostics[1].message.includes("'/entries/0/callback'"));
    assert.deepStrictEqual(result.units, []);
  });

  it("retains a bound function's definition range while reporting its sink path", () => {
    const source = [
      "let callback = () => 1",
      "model block bound_function { callback callback }"
    ].join("\n");
    const result = compileSource(source.split("\n"));
    const diagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.functionValueNotSerializable"
    );

    assert.ok(diagnostic);
    assert.strictEqual(source.slice(diagnostic.range.start, diagnostic.range.end), "() => 1");
    assert.ok(diagnostic.message.includes("'/callback'"));
    assert.deepStrictEqual(result.units, []);
  });

  it("reports optional absence as a missing JSON value and emits no null unit", () => {
    const source = [
      "type Config = { value?: String }",
      "let config: Config = {}",
      "model block missing_value { value config.value }"
    ].join("\n");
    const result = compileSource(source.split("\n"));
    const loweringDiagnostic = result.diagnostics.find(item =>
      item.code === "rsgl.missingValueNotSerializable"
    );

    assert.ok(result.diagnostics.some(item => item.code === "rsgl.optionalFieldMayBeMissing"));
    assert.ok(loweringDiagnostic);
    assert.strictEqual(
      source.slice(loweringDiagnostic.range.start, loweringDiagnostic.range.end),
      "config.value"
    );
    assert.ok(loweringDiagnostic.message.includes("'/value'"));
    assert.deepStrictEqual(result.units, []);
  });

  it("does not lower omitted branches or absent optional syntax as missing JSON", () => {
    const result = compileSource([
      "type Config = { value?: String }",
      "let config: Config = {}",
      "model block guarded_value {",
      "  if has(config, \"value\") { value config.value } else { value \"fallback\" }",
      "  if false { callback (() => 1) }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, { value: "fallback" });
  });

  it("lowers a function call result instead of rejecting the function callee", () => {
    const result = compileSource([
      "let makeValue: () -> Json = () => ({ nested: [1, 2] })",
      "model block called_function { merge makeValue() }"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, { nested: [1, 2] });
  });

  it("applies the same recursive checks to specialized JSON resource sinks", () => {
    const source = [
      "model block geometry_bad { callback (() => 1) }",
      "mcmeta \"assets/minecraft/textures/block/anim.png\" { use mcmetaAnimation(frames: [(() => 2)]) }",
      "equipment minecraft:bad { layer humanoid texture minecraft:bad dyeable color (() => 3) }"
    ].join("\n");
    const result = compileSource(source.split("\n"));
    const diagnostics = result.diagnostics.filter(item =>
      item.code === "rsgl.functionValueNotSerializable"
    );

    assert.strictEqual(diagnostics.length, 3);
    assert.deepStrictEqual(
      diagnostics.map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end)),
      ["() => 1", "() => 2", "() => 3"]
    );
    assert.ok(diagnostics[0].message.includes("'/callback'"));
    assert.ok(diagnostics[1].message.includes("'/animation/frames/0'"));
    assert.ok(diagnostics[2].message.includes("'/layers/humanoid/0/dyeable/color_when_undyed'"));
    assert.deepStrictEqual(result.units, []);
  });

  it("allows future runtime domains to opt into JSON through a narrow adapter", () => {
    const brandedId = { kind: "brandedId", value: "minecraft:stone" };
    const context: EvaluationContext = {
      namespace: "minecraft",
      variables: new Map([
        ["branded", brandedId as unknown as EvaluationValue]
      ])
    };
    const adapterPaths: string[] = [];
    const value = evaluateJsonExpression(parseExpression("{ nested: [branded] }"), context, {
      jsonValueAdapters: [{
        lower: (candidate, adapterContext) => {
          if (candidate !== brandedId) {
            return undefined;
          }
          adapterPaths.push(adapterContext.generatedPath);
          return { kind: "value", value: brandedId.value };
        }
      }]
    });

    assert.deepStrictEqual(value, { nested: ["minecraft:stone"] });
    assert.deepStrictEqual(adapterPaths, ["/nested/0"]);
  });

  it("does not confuse ordinary marker-shaped JSON with compiler runtime values", () => {
    const result = compileSource([
      "json \"assets/example/marker.json\" { merge { kind: \"lambda\", value: 1 } }"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, { kind: "lambda", value: 1 });

    const namespaceMarker = compileSource([
      "json \"assets/example/namespace-marker.json\" {",
      "  merge { kind: \"moduleNamespace\", values: {}, templates: {} }",
      "}"
    ]);
    expectNoDiagnostics(namespaceMarker);
    assert.deepStrictEqual(namespaceMarker.units[0].content, {
      kind: "moduleNamespace",
      values: {},
      templates: {}
    });
  });

  it("preserves prototype-named own properties through lowering and fragment merge", () => {
    const result = compileSource([
      "json \"assets/example/prototype-key.json\" {",
      "  merge mergeObjects({ \"__proto__\": { polluted: true } }, { safe: true })",
      "}"
    ]);

    expectNoDiagnostics(result);
    const content = result.units[0].content as Record<string, unknown>;
    assert.strictEqual(Object.hasOwn(content, "__proto__"), true);
    assert.deepStrictEqual(content["__proto__"], { polluted: true });
    assert.ok(JSON.stringify(content).includes('"__proto__":{"polluted":true}'));
    assert.ok(stableJsonStringify(result.units[0].content as JsonValue, result.units[0].kind)
      .includes('"__proto__": {'));
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("rejects a dedicated module namespace runtime value at its nested path", () => {
    const namespaceValue = new ModuleNamespaceValue({
      fileName: "/virtual/library.rsgl",
      namespace: "minecraft",
      valueBindings: new Map(),
      templates: new Map()
    });
    const context: EvaluationContext = {
      namespace: "minecraft",
      variables: new Map([
        ["namespaceValue", namespaceValue as unknown as EvaluationValue]
      ])
    };
    const diagnostics: Array<{ code: string; message: string }> = [];
    const value = evaluateJsonExpression(
      parseExpression("{ nested: namespaceValue }"),
      context,
      {
        onError: (code, message) => diagnostics.push({ code, message })
      }
    );

    assert.strictEqual(value, undefined);
    assert.deepStrictEqual(diagnostics.map(item => item.code), [
      "rsgl.moduleNamespaceValueNotSerializable"
    ]);
    assert.ok(diagnostics[0].message.includes("'/nested'"));
  });
});

function parseExpression(source: string): ExprNode {
  const module = parseRsgl(`let result = ${source}`);
  const statement = module.statements[0];
  if (!statement || statement.kind !== "LetDecl") {
    throw new Error(`Expected a let expression for '${source}'.`);
  }
  return statement.value;
}
