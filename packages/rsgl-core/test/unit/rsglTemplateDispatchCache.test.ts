import * as assert from "node:assert/strict";
import { createTemplateDefinition } from "../../src/compiler/environment";
import { RsglTemplateDispatchCache } from "../../src/compiler/templateDispatchCache";
import { parseRsgl, type TemplateDeclNode } from "../../src/parser";
import { compileSourceWithUncheckedExterns, generatedResourceUnits } from "./helpers/compile";

describe("RSGL template dispatch cache", () => {
  it("keys dispatch plans by definition, body kind, and normalized caller context", () => {
    const template = parseRsgl(
      "template fields() -> model { custom true }"
    ).statements[0] as TemplateDeclNode;
    const definition = createTemplateDefinition(
      "fields",
      template,
      "definitions.rsgl",
      "minecraft",
      new Map(),
      new Map(),
      { outputSource: "explicitArrow", outputDialect: "model" }
    );
    const cache = new RsglTemplateDispatchCache(8);
    const modelContext = { kind: "resourceBody", resourceKind: "model" } as const;
    const jsonContext = { kind: "resourceBody", resourceKind: "json" } as const;

    assert.strictEqual(cache.resolve(definition, modelContext).compatible, true);
    assert.strictEqual(cache.resolve(definition, modelContext).compatible, true);
    assert.strictEqual(cache.size, 1);
    assert.strictEqual(cache.resolve(definition, jsonContext).compatible, false);
    assert.strictEqual(cache.size, 2);
    definition.definitionFingerprint = `${definition.definitionFingerprint}-changed`;
    cache.resolve(definition, modelContext);
    assert.strictEqual(cache.size, 3);
  });

  it("never reuses evaluated arguments when a dispatch plan is cached", () => {
    const result = compileSourceWithUncheckedExterns([
      "template fields(value: Json) -> model { custom value }",
      "model block one { use fields(1) }",
      "model block two { use fields(2) }"
    ]);

    assert.deepStrictEqual(
      generatedResourceUnits(result).map(unit => unit.content),
      [{ custom: 1 }, { custom: 2 }]
    );
    assert.deepStrictEqual(result.diagnostics, []);
  });
});
