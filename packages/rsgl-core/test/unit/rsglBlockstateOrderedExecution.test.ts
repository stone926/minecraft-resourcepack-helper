import * as assert from "node:assert";
import {
  type BaseDocument,
  type JsonValue
} from "../../src/compiler";
import { RsglCompiler } from "../../src/compiler/compiler";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  unitByPath,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL ordered blockstate root execution", () => {
  it("finalizes both empty modes and maps only the canonical header token", () => {
    const source = [
      "blockstate variants empty_variants {}",
      "blockstate multipart empty_multipart {}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));

    expectNoDiagnostics(result);
    const variants = unitByPath(result, "blockstates/empty_variants.json");
    const multipart = unitByPath(result, "blockstates/empty_multipart.json");
    assert.deepStrictEqual(variants.content, { variants: {} });
    assert.deepStrictEqual(multipart.content, { multipart: [] });
    assert.deepStrictEqual(
      variants.sourceMap.mappings.find(mapping => mapping.generatedPath === "/variants")?.sourceRange,
      textRange(source, "variants")
    );
    assert.deepStrictEqual(
      multipart.sourceMap.mappings.find(mapping => mapping.generatedPath === "/multipart")?.sourceRange,
      textRange(source, "multipart")
    );
  });

  it("loads a first root base once and rejects later or nested base statements before loading", () => {
    const loads: string[] = [];
    const valid = compileSourceWithUncheckedExterns([
      "blockstate variants base_first {",
      "  base \"./base.json\"",
      "  custom { after: true }",
      "}"
    ], {
      baseDocumentLoader: {
        load(request) {
          loads.push(request);
          return baseDocument({
            base_only: true,
            variants: {
              "source=base": { model: "minecraft:block/base" }
            }
          }, request);
        }
      }
    });
    const invalidModule = parseRsgl([
      "blockstate variants base_late {",
      "  custom { before: true }",
      "  base \"./late.json\"",
      "}",
      "blockstate variants base_nested {",
      "  if true {",
      "    base \"./nested.json\"",
      "  }",
      "}"
    ].join("\n"));
    const invalid = new RsglCompiler(invalidModule, {
      fileName: "base-invalid.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      baseDocumentLoader: {
        load(request) {
          loads.push(request);
          return baseDocument({}, request);
        }
      }
    }).compile();

    assert.strictEqual(loads.length, 1);
    assert.ok(loads[0].replaceAll("\\", "/").endsWith("/base.json"));
    expectNoDiagnostics(valid);
    assert.deepStrictEqual(invalidModule.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.baseMustPrecedeBody",
      "rsgl.baseInvalidContext"
    ]);
    assert.deepStrictEqual(invalid.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.baseMustPrecedeBody",
      "rsgl.baseInvalidContext"
    ]);
    assert.deepStrictEqual(unitByPath(valid, "blockstates/base_first.json").content, {
      base_only: true,
      variants: {
        "source=base": { model: "minecraft:block/base" }
      },
      custom: { after: true }
    });
    assert.deepStrictEqual(unitByPath(invalid, "blockstates/base_late.json").content, {
      custom: { before: true },
      variants: {}
    });
    assert.deepStrictEqual(unitByPath(invalid, "blockstates/base_nested.json").content, {
      variants: {}
    });
  });

  it("keeps custom fields and entry, merge, use, let, for, and if effects on one ordered root", () => {
    const result = compileSourceWithUncheckedExterns([
      "template middle() -> variants {",
      "  { order: third }: minecraft:block/third",
      "}",
      "blockstate variants ordered {",
      "  custom { phase: \"first\", nested: { first: true } }",
      "  { order: first }: minecraft:block/first",
      "  merge upsert {",
      "    custom: { phase: \"second\" },",
      "    variants: { \"order=second\": { model: minecraft:block/second } }",
      "  }",
      "  use middle()",
      "  let fourthModel = minecraft:block/fourth",
      "  { order: fourth }: fourthModel",
      "  for order in [\"fifth\", \"sixth\"] {",
      "    { order: order }: `minecraft:block/${order}`",
      "  }",
      "  if true {",
      "    merge deep { custom: { nested: { conditional: true } } }",
      "    { order: seventh }: minecraft:block/seventh",
      "  }",
      "  merge upsert { variants: { \"order=first\": { model: minecraft:block/first_patched } } }",
      "  merge upsert { variants: { \"order=eighth\": { model: minecraft:block/eighth } } }",
      "  { order: eighth }: minecraft:block/rejected",
      "}"
    ]);

    assert.deepStrictEqual(
      result.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.blockstateVariantEntryConflict"]
    );
    const content = unitByPath(result, "blockstates/ordered.json").content as {
      custom: JsonValue;
      variants: Record<string, JsonValue>;
    };
    assert.deepStrictEqual(content.custom, {
      phase: "second",
      nested: { first: true, conditional: true }
    });
    assert.deepStrictEqual(Object.keys(content.variants), [
      "order=first",
      "order=second",
      "order=third",
      "order=fourth",
      "order=fifth",
      "order=sixth",
      "order=seventh",
      "order=eighth"
    ]);
    assert.deepStrictEqual(content.variants["order=first"], {
      model: "minecraft:block/first_patched"
    });
    assert.deepStrictEqual(content.variants["order=eighth"], {
      model: "minecraft:block/eighth"
    });
  });

  it("preserves multiple root-only merge modes before finalization", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants merge_modes {",
      "  merge upsert {",
      "    custom: { enabled: true, nested: { first: 1 } },",
      "    variants: { \"phase=initial\": { model: minecraft:block/initial, x: 0 } }",
      "  }",
      "  merge deep { custom: { nested: { second: 2 } } }",
      "  merge strict { custom: { enabled: false } }",
      "  merge strict { variants: { \"phase=initial\": { model: minecraft:block/final } } }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "blockstates/merge_modes.json").content, {
      custom: {
        enabled: false,
        nested: { first: 1, second: 2 }
      },
      variants: {
        "phase=initial": { model: "minecraft:block/final", x: 0 }
      }
    });
  });

  it("uses the actual multipart length for base, direct, merge, template, and nested entries", () => {
    const result = compileSourceWithUncheckedExterns([
      "template middle() -> multipart {",
      "  apply minecraft:block/template",
      "}",
      "blockstate multipart indexed {",
      "  base \"./multipart-base.json\"",
      "  apply minecraft:block/direct",
      "  merge append { multipart: [",
      "    { apply: { model: minecraft:block/merged_a } },",
      "    { apply: { model: minecraft:block/merged_b } }",
      "  ] }",
      "  use middle()",
      "  if true { apply minecraft:block/nested }",
      "}"
    ], {
      baseDocumentLoader: {
        load(request) {
          return baseDocument({
            multipart: [{ apply: { model: "minecraft:block/base" } }]
          }, request, new Map([
            ["", { start: 0, end: 65 }],
            ["/multipart", { start: 1, end: 64 }],
            ["/multipart/0", { start: 15, end: 63 }],
            ["/multipart/0/apply/model", { start: 36, end: 58 }]
          ]));
        }
      }
    });

    expectNoDiagnostics(result);
    const unit = unitByPath(result, "blockstates/indexed.json");
    assert.deepStrictEqual(unit.content, {
      multipart: [
        { apply: { model: "minecraft:block/base" } },
        { apply: { model: "minecraft:block/direct" } },
        { apply: { model: "minecraft:block/merged_a" } },
        { apply: { model: "minecraft:block/merged_b" } },
        { apply: { model: "minecraft:block/template" } },
        { apply: { model: "minecraft:block/nested" } }
      ]
    });
    const modelMappings = unit.sourceMap.mappings.filter(mapping =>
      /^\/multipart\/\d+\/apply\/model$/.test(mapping.generatedPath)
    );
    assert.deepStrictEqual(modelMappings.map(mapping => mapping.generatedPath), [
      "/multipart/0/apply/model",
      "/multipart/1/apply/model",
      "/multipart/2/apply/model",
      "/multipart/3/apply/model",
      "/multipart/4/apply/model",
      "/multipart/5/apply/model"
    ]);
    assert.deepStrictEqual(modelMappings.map(mapping => mapping.reason), [
      "base",
      "direct",
      "direct",
      "direct",
      "template",
      "direct"
    ]);
  });

  it("accepts same-mode content and atomically rejects opposite and mixed operands", () => {
    const result = compileSourceWithUncheckedExterns([
      "template sameMode() -> variants { { from: template }: minecraft:block/template }",
      "template oppositeMode() -> multipart { apply minecraft:block/opposite }",
      "blockstate variants guarded {",
      "  custom { kept: true }",
      "  use sameMode()",
      "  merge upsert { variants: { \"from=merge\": { model: minecraft:block/merge } } }",
      "  merge { custom: { kept: false }, multipart: [] }",
      "  merge deep { custom: { kept: false }, variants: {}, multipart: [] }",
      "  use oppositeMode()",
      "}"
    ]);

    assert.ok(result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.blockstateModeConflict"
    ).length >= 3);
    assert.deepStrictEqual(unitByPath(result, "blockstates/guarded.json").content, {
      custom: { kept: true },
      variants: {
        "from=template": { model: "minecraft:block/template" },
        "from=merge": { model: "minecraft:block/merge" }
      }
    });
  });

  it("atomically rejects invalid root shapes and non-serializable root values", () => {
    const result = compileSourceWithUncheckedExterns([
      "blockstate variants invalid_shape {",
      "  merge upsert { custom: { rejected: true }, variants: [] }",
      "}",
      "blockstate variants invalid_value {",
      "  merge upsert { custom: { rejected: [][0] } }",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.invalidBlockstateVariantsRoot"));
    assert.ok(codes.includes("rsgl.missingValueNotSerializable"));
    assert.deepStrictEqual(unitByPath(result, "blockstates/invalid_shape.json").content, {
      variants: {}
    });
    assert.strictEqual(result.units.some(unit =>
      unit.outputPath.endsWith("blockstates/invalid_value.json")
    ), false);
  });

  it("retains expression-path ranges for nested root merge mappings", () => {
    const source = [
      "blockstate variants mapped_merge {",
      "  merge upsert { custom: { enabled: true } }",
      "}"
    ].join("\n");
    const result = compileSourceWithUncheckedExterns(source.split("\n"));
    const unit = unitByPath(result, "blockstates/mapped_merge.json");
    const enabledMappings = unit.sourceMap.mappings.filter(mapping =>
      mapping.generatedPath === "/custom/enabled"
    );

    expectNoDiagnostics(result);
    assert.ok(enabledMappings.some(mapping =>
      source.slice(mapping.sourceRange.start, mapping.sourceRange.end) === "true"
    ));
  });

  it("evaluates explicit arguments in call-site order and defaults once with both provenances", () => {
    const source = [
      "template emitted(",
      "  firstModel: ModelId,",
      "  secondModel: ModelId,",
      "  fallbackModel: ModelId = glob(\"default\")[0]",
      ") -> variants {",
      "  { slot: first }: firstModel",
      "  { slot: second }: secondModel",
      "  { slot: fallback }: fallbackModel",
      "}",
      "blockstate variants provenance {",
      "  use emitted(",
      "    secondModel: glob(\"second\")[0],",
      "    firstModel: glob(\"first\")[0]",
      "  )",
      "}"
    ].join("\n");
    const module = parseRsgl(source);
    const semantic = bindRsglModule(module);
    const calls: string[] = [];
    const result = new RsglCompiler(module, {
      ...withUncheckedExterns({}),
      fileName: "ordered-provenance.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      blockstateApplyFacts: semantic.blockstateApplyFacts,
      globLoader: pattern => {
        calls.push(pattern);
        return [`minecraft:block/${pattern}`];
      }
    }).compile();

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(semantic.diagnostics, []);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(calls, ["second", "first", "default"]);
    assert.deepStrictEqual(result.units[0].content, {
      variants: {
        "slot=first": { model: "minecraft:block/first" },
        "slot=second": { model: "minecraft:block/second" },
        "slot=fallback": { model: "minecraft:block/default" }
      }
    });

    const firstMapping = result.units[0].sourceMap.mappings.find(mapping =>
      mapping.generatedPath === "/variants/slot=first/model"
    );
    const fallbackMapping = result.units[0].sourceMap.mappings.find(mapping =>
      mapping.generatedPath === "/variants/slot=fallback/model"
    );
    const firstOrigin = result.units[0].validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/variants/slot=first/model"
    );
    const fallbackOrigin = result.units[0].validation?.referenceOrigins?.find(origin =>
      origin.generatedPath === "/variants/slot=fallback/model"
    );
    assert.deepStrictEqual(firstMapping?.sourceRange, textRange(source, "firstModel", 1));
    assert.deepStrictEqual(fallbackMapping?.sourceRange, textRange(source, "fallbackModel", 1));
    assert.deepStrictEqual(
      firstOrigin?.sourceRange,
      spanningRange(source, "glob(\"first\")", "\"first\"")
    );
    assert.deepStrictEqual(
      fallbackOrigin?.sourceRange,
      spanningRange(source, "glob(\"default\")", "\"default\"")
    );
    assert.ok(firstMapping?.expansionStack.some(frame => frame.label === "use emitted"));
  });
});

function baseDocument(
  content: JsonValue,
  sourceFile: string,
  sourceRanges: ReadonlyMap<string, { start: number; end: number }> = new Map([
    ["", { start: 0, end: 1 }]
  ])
): BaseDocument {
  return {
    content,
    sourceFile,
    sourceRange: sourceRanges.get("") ?? { start: 0, end: 1 },
    sourceRanges,
    dependencies: []
  };
}

function textRange(source: string, text: string, occurrence = 0): { start: number; end: number } {
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(text, start + 1);
  }
  assert.notStrictEqual(start, -1, `Missing source text: ${text}`);
  return { start, end: start + text.length };
}

function spanningRange(source: string, startText: string, endText: string): {
  start: number;
  end: number;
} {
  return {
    start: textRange(source, startText).start,
    end: textRange(source, endText).end
  };
}
