import * as assert from "node:assert/strict";
import {
  BlockstateRootMerger,
  type BlockstateContentMergeHost,
  type BlockstateSourceRange
} from "../../src/compiler/blockstateContentMerge";
import type { RsglMapping } from "../../src/compiler/ir";
import type { RsglCompileContext } from "../../src/compiler/templateExpansion";

const rootRange = { start: 10, end: 20 };
const directRange = { start: 30, end: 40 };
const context: RsglCompileContext = {
  namespace: "minecraft",
  variables: new Map(),
  sourceFile: "blockstates.rsgl",
  mappingReason: "direct",
  expansionStack: []
};

interface CapturedError {
  code: string;
  message: string;
  range: BlockstateSourceRange;
}

describe("RSGL ordered blockstate root merger", () => {
  it("adds the selected field only during finalization", () => {
    const variantsFixture = fixture();
    const variants = variantsFixture.merger.createState("variants");
    const multipartFixture = fixture();
    const multipart = multipartFixture.merger.createState("multipart");

    assert.deepStrictEqual(variants.content, {});
    assert.deepStrictEqual(multipart.content, {});

    variantsFixture.merger.finalize(variants, { sourceRange: rootRange, context });
    multipartFixture.merger.finalize(multipart, { sourceRange: rootRange, context });

    assert.deepStrictEqual(variants.content, { variants: {} });
    assert.deepStrictEqual(multipart.content, { multipart: [] });
    assert.deepStrictEqual(variants.mappings.map(item => item.generatedPath), ["/variants"]);
    assert.deepStrictEqual(multipart.mappings.map(item => item.generatedPath), ["/multipart"]);
  });

  it("replaces selected-field mappings with one authoritative header origin", () => {
    const { merger, mapping } = fixture();
    const state = merger.createState("variants");
    const baseRootMapping = { ...mapping("/variants"), reason: "base" as const };
    const baseChildMapping = { ...mapping("/variants/existing/model"), reason: "base" as const };

    assert.strictEqual(merger.initializeBase(
      state,
      { variants: { existing: { model: "minecraft:block/base" } } },
      rootRange,
      [baseRootMapping, baseChildMapping]
    ), true);
    assert.ok(merger.mergeRoot(
      state,
      { variants: { merged: { model: "minecraft:block/merged" } } },
      "upsert",
      directRange,
      context,
      [
        mapping("/variants", directRange),
        mapping("/variants/merged/model", directRange)
      ]
    ));

    const headerRange = { start: 1, end: 9 };
    merger.finalize(state, { sourceRange: headerRange, context });

    const rootMappings = state.mappings.filter(item => item.generatedPath === "/variants");
    assert.strictEqual(rootMappings.length, 1);
    assert.deepStrictEqual(rootMappings[0].sourceRange, headerRange);
    assert.strictEqual(rootMappings[0].reason, "direct");
    assert.ok(state.mappings.some(item =>
      item.generatedPath === "/variants/existing/model" && item.reason === "base"
    ));
    assert.ok(state.mappings.some(item => item.generatedPath === "/variants/merged/model"));
  });

  it("does not let final field completion change strict merge semantics", () => {
    const { merger, errors } = fixture();
    const state = merger.createState("variants");

    const result = merger.mergeRoot(
      state,
      { variants: { "": { model: "minecraft:block/stone" } } },
      "strict",
      directRange,
      context
    );

    assert.ok(result);
    assert.deepStrictEqual(result.applied, {});
    assert.deepStrictEqual(state.content, {});
    assert.deepStrictEqual(errors.map(error => error.code), ["rsgl.mergeFieldNotFound"]);

    merger.finalize(state);
    assert.deepStrictEqual(state.content, { variants: {} });
  });

  it("accepts neutral and same-mode operands but rejects conflicts atomically", () => {
    const { merger, errors } = fixture();
    const state = merger.createState("variants");

    assert.ok(merger.mergeRoot(
      state,
      { custom: { enabled: true } },
      "upsert",
      rootRange,
      context
    ));
    assert.ok(merger.mergeRoot(
      state,
      { variants: { "": { model: "minecraft:block/base" } } },
      "upsert",
      rootRange,
      context
    ));
    assert.deepStrictEqual(state.content, {
      custom: { enabled: true },
      variants: { "": { model: "minecraft:block/base" } }
    });

    const beforeConflicts = structuredClone(state.content);
    assert.strictEqual(merger.mergeRoot(
      state,
      { custom: { enabled: false }, multipart: [] },
      "shallow",
      directRange,
      context
    ), undefined);
    assert.strictEqual(merger.mergeRoot(
      state,
      { custom: { enabled: false }, variants: {}, multipart: [] },
      "shallow",
      directRange,
      context
    ), undefined);

    assert.deepStrictEqual(state.content, beforeConflicts);
    assert.deepStrictEqual(errors.map(error => error.code), [
      "rsgl.blockstateModeConflict",
      "rsgl.blockstateModeConflict"
    ]);
    assert.ok(errors.every(error => error.range === directRange));
  });

  it("preflights a base document before replacing root content or mappings", () => {
    const { merger, errors, mapping } = fixture();
    const state = merger.createState("multipart");
    const rejectedMapping = mapping("/custom", directRange);

    assert.strictEqual(merger.initializeBase(
      state,
      { custom: true, variants: {} },
      directRange,
      [rejectedMapping]
    ), false);
    assert.deepStrictEqual(state.content, {});
    assert.strictEqual(state.mappings.length, 0);
    assert.deepStrictEqual(errors.map(error => error.code), ["rsgl.blockstateModeConflict"]);

    assert.strictEqual(merger.initializeBase(
      state,
      { custom: true, multipart: [] },
      rootRange,
      [mapping("/custom", rootRange)]
    ), true);
    assert.deepStrictEqual(state.content, { custom: true, multipart: [] });
    assert.deepStrictEqual(state.mappings.map(item => item.generatedPath), ["/custom"]);
  });

  it("tracks base, merge, and direct writers without overwriting conflicts", () => {
    const { merger, errors } = fixture();
    const state = merger.createState("variants");

    assert.strictEqual(merger.initializeBase(
      state,
      { variants: { base: { model: "minecraft:block/base" } } },
      rootRange
    ), true);
    assert.strictEqual(merger.insertVariant(
      state,
      "base",
      { model: "minecraft:block/direct" },
      directRange,
      context
    ), false);

    assert.strictEqual(merger.insertVariant(
      state,
      "direct",
      { model: "minecraft:block/first" },
      directRange,
      context
    ), true);
    assert.strictEqual(merger.insertVariant(
      state,
      "direct",
      { model: "minecraft:block/second" },
      { start: 41, end: 50 },
      context
    ), false);

    assert.ok(merger.mergeRoot(
      state,
      { variants: { merged: { model: "minecraft:block/merged" } } },
      "upsert",
      rootRange,
      context
    ));
    assert.strictEqual(merger.insertVariant(
      state,
      "merged",
      { model: "minecraft:block/direct" },
      { start: 51, end: 60 },
      context
    ), false);

    assert.ok(merger.mergeRoot(
      state,
      { variants: { direct: { model: "minecraft:block/patched" } } },
      "upsert",
      rootRange,
      context
    ));
    assert.strictEqual(merger.insertVariant(
      state,
      "direct",
      { model: "minecraft:block/third" },
      { start: 61, end: 70 },
      context
    ), false);

    assert.deepStrictEqual(state.content, {
      variants: {
        base: { model: "minecraft:block/base" },
        direct: { model: "minecraft:block/patched" },
        merged: { model: "minecraft:block/merged" }
      }
    });
    assert.deepStrictEqual(errors.map(error => error.code), [
      "rsgl.blockstateVariantEntryConflict",
      "rsgl.duplicateBlockstateVariantEntry",
      "rsgl.blockstateVariantEntryConflict",
      "rsgl.blockstateVariantEntryConflict"
    ]);
  });

  it("uses the current multipart length for merge and direct mapping offsets", () => {
    const { merger, errors, mapping } = fixture();
    const state = merger.createState("multipart");

    assert.strictEqual(merger.initializeBase(state, {
      multipart: [
        { apply: { model: "minecraft:block/base_0" } },
        { apply: { model: "minecraft:block/base_1" } }
      ]
    }, rootRange), true);

    assert.ok(merger.mergeRoot(
      state,
      { multipart: [{ apply: { model: "minecraft:block/merged" } }] },
      "append",
      directRange,
      context,
      [mapping("/multipart/0/apply/model", directRange)]
    ));
    const directIndex = merger.appendMultipart(
      state,
      { apply: { model: "minecraft:block/direct" } },
      { start: 41, end: 50 },
      context,
      [mapping("/apply/model", { start: 41, end: 50 })]
    );

    assert.strictEqual(directIndex, 3);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual((state.content.multipart as unknown[]).length, 4);
    assert.deepStrictEqual(state.mappings.map(item => item.generatedPath), [
      "/multipart/2/apply/model",
      "/multipart/3/apply/model"
    ]);
  });
});

function fixture(): {
  merger: BlockstateRootMerger;
  errors: CapturedError[];
  mapping: (generatedPath: string, sourceRange?: BlockstateSourceRange) => RsglMapping;
} {
  const errors: CapturedError[] = [];
  const mapping = (
    generatedPath: string,
    sourceRange: BlockstateSourceRange = rootRange
  ): RsglMapping => ({
    generatedPath,
    sourceFile: context.sourceFile ?? "blockstates.rsgl",
    sourceRange,
    reason: "direct",
    expansionStack: []
  });
  const host: BlockstateContentMergeHost = {
    onError: (code, message, range) => errors.push({ code, message, range }),
    sourceMapping: (generatedPath, sourceRange, mappingContext) => ({
      generatedPath,
      sourceFile: mappingContext.sourceFile ?? "blockstates.rsgl",
      sourceRange,
      reason: mappingContext.mappingReason ?? "direct",
      expansionStack: mappingContext.expansionStack ?? []
    })
  };
  return { merger: new BlockstateRootMerger(host), errors, mapping };
}
