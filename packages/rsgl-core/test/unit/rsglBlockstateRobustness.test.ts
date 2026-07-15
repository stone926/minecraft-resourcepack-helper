import * as assert from "node:assert";
import * as path from "node:path";
import { compileRsglProgram } from "../../src/compiler";
import {
  BlockstateVariantSelectorIndex,
  parseBlockstateVariantSelector
} from "../../src/compiler/blockstateVariantSelectors";
import { parseRsgl } from "../../src/parser";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL blockstate refactor robustness", () => {
  it("reuses StatePredicate values through calls and conditional expressions", () => {
    const result = compileSourceWithUncheckedExterns([
      "let pass: (StatePredicate) -> StatePredicate = value => value",
      "let attached: StatePredicate =",
      "  $state.north == true",
      "let conditional: StatePredicate = true ? ($state.east == true) : ($state.west == true)",
      "blockstate multipart reused {",
      "  part when pass(attached) => minecraft:block/call",
      "  part when (true ? attached : attached) => minecraft:block/conditional",
      "  part when conditional => minecraft:block/direct_conditional",
      "}"
    ]);

    assert.deepStrictEqual(
      result.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.duplicateMultipartPredicateHint"]
    );
    assert.deepStrictEqual(result.units[0].content, {
      multipart: [
        {
          apply: { model: "minecraft:block/call" },
          when: { north: "true" }
        },
        {
          apply: { model: "minecraft:block/conditional" },
          when: { north: "true" }
        },
        {
          apply: { model: "minecraft:block/direct_conditional" },
          when: { east: "true" }
        }
      ]
    });
  });

  it("rejects StatePredicate as compile-time control flow and membership outside predicate context", () => {
    const result = compileSourceWithUncheckedExterns([
      "let attached: StatePredicate = $state.north == true",
      "let ordinaryMembership = 1 in [1, 2]",
      "blockstate variants invalid_control {",
      "  if attached { case * => minecraft:block/never }",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.statePredicateCompileTimeCondition"));
    assert.ok(codes.includes("rsgl.statePredicateOperatorContext"));
    assert.strictEqual(result.units.length, 0, "invalid compile-time predicate control flow must not emit a unit");
  });

  it("does not accept forged runtime predicate objects", () => {
    const source = [
      "template emit(p) -> multipart { part when p => minecraft:block/model }",
      "blockstate multipart forged {",
      "  use emit(p: {",
      "    kind: \"rsgl.statePredicate\",",
      "    predicate: { kind: \"and\", terms: \"not-an-array\" }",
      "  })",
      "}"
    ];
    let result: ReturnType<typeof compileSourceWithUncheckedExterns> | undefined;

    assert.doesNotThrow(() => {
      result = compileSourceWithUncheckedExterns(source);
    });
    assert.ok(result?.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.invalidBlockstatePredicate"
    ));
  });

  it("limits deeply nested predicates before recursive checking or evaluation", () => {
    const predicate = Array.from(
      { length: 600 },
      (_, index) => `$state.p == v${index}`
    ).join(" || ");
    let result: ReturnType<typeof compileSourceWithUncheckedExterns> | undefined;

    assert.doesNotThrow(() => {
      result = compileSourceWithUncheckedExterns([
        "blockstate multipart deep_predicate {",
        `  part when ${predicate} => minecraft:block/model`,
        "}"
      ]);
    });
    assert.ok(result?.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.blockstatePredicateTooComplex"
    ));
  });

  it("handles prototype-like state names against schemas without inherited lookups", () => {
    let result: ReturnType<typeof compileSourceWithUncheckedExterns> | undefined;
    assert.doesNotThrow(() => {
      result = compileSourceWithUncheckedExterns([
        "blockstate multipart prototype_state {",
        "  part when $state.__proto__ == enabled => minecraft:block/model",
        "}"
      ], {
        blockstateSchema: () => ({ properties: { facing: ["north"] } })
      });
    });
    assert.ok(result?.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.unknownBlockstateStateProperty"
    ));
  });

  it("preserves template definition mappings for choice options and predicates", () => {
    const mainFile = path.resolve("virtual", "main.rsgl");
    const libraryFile = path.resolve("virtual", "library.rsgl");
    const librarySource = [
      "let libraryPredicate: StatePredicate = $state.unknown == true",
      "template libraryChoice() -> choice {",
      "  option minecraft:block/from_library with { y: 90 } weight 2",
      "}",
      "template libraryPart() -> multipart {",
      "  part when libraryPredicate => minecraft:block/predicate_model",
      "}",
      "export { libraryChoice, libraryPart }"
    ].join("\n");
    const mainSource = [
      "import { libraryChoice, libraryPart } from \"./library.rsgl\"",
      "blockstate variants mapped_choice {",
      "  case * => random { use libraryChoice() }",
      "}",
      "blockstate multipart mapped_predicate { use libraryPart() }"
    ].join("\n");
    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: libraryFile, module: parseRsgl(librarySource) }
    ], withUncheckedExterns({
      entryFileName: mainFile,
      blockstateSchema: () => ({ properties: { facing: ["north"] } })
    }));

    const choiceUnit = result.units.find(unit => unit.id?.path === "mapped_choice");
    assert.ok(choiceUnit);
    const modelMapping = choiceUnit.sourceMap.mappings.find(mapping =>
      mapping.generatedPath.endsWith("/0/model")
    );
    assert.ok(modelMapping);
    assert.strictEqual(path.normalize(modelMapping.sourceFile), path.normalize(libraryFile));
    assert.strictEqual(modelMapping.reason, "template");
    assert.strictEqual(modelMapping.expansionStack.length, 1);

    const schemaDiagnostic = result.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.unknownBlockstateStateProperty"
    );
    assert.ok(schemaDiagnostic);
    assert.strictEqual(path.normalize(schemaDiagnostic.fileName ?? ""), path.normalize(libraryFile));
    assert.match(
      librarySource.slice(schemaDiagnostic.range.start, schemaDiagnostic.range.end),
      /\$state\.unknown|unknown/
    );
  });

  it("attributes imported template execution diagnostics to their definitions", () => {
    const mainFile = path.resolve("virtual", "diagnostic-main.rsgl");
    const libraryFile = path.resolve("virtual", "diagnostic-library.rsgl");
    const librarySource = [
      "template badRotation(y: Number) -> choice {",
      "  option minecraft:block/rotation with { y }",
      "}",
      "template badWeight(w: Number) -> choice {",
      "  option minecraft:block/weight weight w",
      "}",
      "template badPredicate(p) -> multipart {",
      "  part when p => minecraft:block/predicate",
      "}",
      "template overlapping() -> variants {",
      "  case { facing: north } => minecraft:block/overlap",
      "}",
      "export { badRotation, badWeight, badPredicate, overlapping }"
    ].join("\n");
    const mainSource = [
      "import { badRotation, badWeight, badPredicate, overlapping } from \"./diagnostic-library.rsgl\"",
      "blockstate variants bad_rotation { case * => random { use badRotation(45) } }",
      "blockstate variants bad_weight { case * => random { use badWeight(0) } }",
      "blockstate multipart bad_predicate { use badPredicate(false) }",
      "blockstate variants bad_overlap {",
      "  case { facing: north, lit: true } => minecraft:block/specific",
      "  use overlapping()",
      "}"
    ].join("\n");
    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: libraryFile, module: parseRsgl(librarySource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    for (const code of [
      "rsgl.invalidBlockstateRotation",
      "rsgl.invalidRandomWeight",
      "rsgl.invalidBlockstatePredicate",
      "rsgl.overlappingBlockstateVariantEntry"
    ]) {
      const diagnostic = result.diagnostics.find(item => item.code === code);
      assert.ok(diagnostic, `expected ${code}`);
      assert.strictEqual(
        path.normalize(diagnostic.fileName ?? ""),
        path.normalize(libraryFile),
        `${code} should point into the imported template definition`
      );
    }
  });

  it("indexes large disjoint variant tables and still finds partial overlaps", () => {
    const index = new BlockstateVariantSelectorIndex();
    for (let slot = 0; slot < 10_000; slot += 1) {
      const selector = parseBlockstateVariantSelector(`axis=x,slot=${slot}`);
      assert.ok(selector);
      assert.strictEqual(index.findOverlap(selector), undefined);
      index.add(selector);
    }

    const partial = parseBlockstateVariantSelector("axis=x");
    assert.ok(partial);
    assert.strictEqual(index.findOverlap(partial), "axis=x,slot=0");

    const disjoint = parseBlockstateVariantSelector("axis=y");
    assert.ok(disjoint);
    assert.strictEqual(index.findOverlap(disjoint), undefined);
  });

  it("keeps a one-option random choice as an array and diagnoses misplaced weight", () => {
    const compiled = compileSourceWithUncheckedExterns([
      "blockstate variants one_option {",
      "  case * => random { option minecraft:block/only }",
      "}"
    ]);
    expectNoDiagnostics(compiled);
    assert.deepStrictEqual(compiled.units[0].content, {
      variants: { "": [{ model: "minecraft:block/only" }] }
    });

    const parsed = parseRsgl(
      "blockstate variants invalid_weight { case * => minecraft:block/model weight 2 }"
    );
    assert.ok(parsed.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.blockstateWeightInvalidContext"
    ));
  });
});
