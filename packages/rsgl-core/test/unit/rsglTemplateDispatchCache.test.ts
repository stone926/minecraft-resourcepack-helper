import * as assert from "node:assert";
import { createTemplateDefinition } from "../../src/compiler/environment";
import { RsglTemplateDispatchCache } from "../../src/compiler/templateDispatchCache";
import { parseRsgl, type TemplateDeclNode } from "../../src/parser";
import { compileSourceWithUncheckedExterns, generatedResourceUnits } from "./helpers/compile";

describe("RSGL template dispatch cache", () => {
  it("keys contextual plans by definition, body kind, and normalized caller context", () => {
    const template = parseRsgl("template fields() { custom true }").statements[0] as TemplateDeclNode;
    const definition = createTemplateDefinition(
      "fields",
      template,
      "definitions.rsgl",
      "minecraft",
      new Map(),
      new Map(),
      { outputSource: "legacyContextualAdapter", bodyNodeKind: "ResourceBody" }
    );
    const cache = new RsglTemplateDispatchCache(8);
    const modelContext = { kind: "resourceBody", resourceKind: "model" } as const;
    const jsonContext = { kind: "resourceBody", resourceKind: "json" } as const;

    assert.strictEqual(cache.resolve(definition, modelContext).compatible, true);
    assert.strictEqual(cache.resolve(definition, modelContext).compatible, true);
    assert.strictEqual(cache.size, 1);
    assert.strictEqual(cache.resolve(definition, jsonContext).compatible, true);
    assert.strictEqual(cache.size, 2);
    definition.definitionFingerprint = `${definition.definitionFingerprint}-changed`;
    cache.resolve(definition, modelContext);
    assert.strictEqual(cache.size, 3);
  });

  it("never reuses evaluated arguments when a dispatch plan is cached", () => {
    const result = compileSourceWithUncheckedExterns([
      "template fields(value: Json) { custom value }",
      "json \"assets/minecraft/custom/one.json\" { use fields(1) }",
      "json \"assets/minecraft/custom/two.json\" { use fields(2) }"
    ]);

    assert.deepStrictEqual(
      generatedResourceUnits(result).map(unit => unit.content),
      [{ custom: 1 }, { custom: 2 }]
    );
    assert.strictEqual(
      result.diagnostics.filter(item => item.code === "rsgl.implicitTemplateOutputDialect").length,
      2
    );
  });

  it("rejects invalid definitions before selecting or caching a caller dialect", () => {
    const template = parseRsgl("template mixed() { custom true }").statements[0] as TemplateDeclNode;
    const definition = createTemplateDefinition(
      "mixed",
      template,
      "definitions.rsgl",
      "minecraft",
      new Map(),
      new Map(),
      { outputSource: "legacyContextualAdapter", bodyNodeKind: "ResourceBody" },
      "target",
      "configuration",
      { evidence: ["resourceBody:model", "blockstateEntries:variants"] }
    );
    const cache = new RsglTemplateDispatchCache(8);

    assert.deepStrictEqual(cache.resolve(definition, {
      kind: "resourceBody",
      resourceKind: "model"
    }), {
      compatible: false,
      compatibilityWarning: false,
      failure: "invalidDefinition"
    });
    assert.strictEqual(cache.size, 0);
  });
});
