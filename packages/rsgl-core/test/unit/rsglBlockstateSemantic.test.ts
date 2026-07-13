import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram } from "../../src/semantic";

describe("RSGL blockstate semantics", () => {
  it("checks selectors contextually without changing ordinary object expressions", () => {
    const source = [
      "let invalidKey = {}",
      "let invalidValue = {}",
      "let ordinary = { facing: custom_enum_literal }",
      "blockstate variants selectors {",
      "  { facing: custom_enum_literal }: minecraft:block/one",
      "  { facing: north, \"facing\": south }: minecraft:block/two",
      "  { [invalidKey]: north }: minecraft:block/three",
      "  { facing: invalidValue }: minecraft:block/four",
      "  (\"north\"): minecraft:block/five",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.undefinedSymbol").length, 1);
    assert.ok(codes.includes("rsgl.duplicateBlockstateSelectorProperty"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorKey"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorValue"));
    assert.ok(codes.includes("rsgl.blockstateSelectorMustBeObject"));
  });

  it("checks multipart conditions contextually through nested OR and AND objects", () => {
    const model = bindRsglModule(parseRsgl([
      "blockstate multipart conditions {",
      "  when { facing: north } apply minecraft:block/north",
      "  when { OR: [{ axis: x }, { axis: z }] } apply minecraft:block/axis",
      "  when { AND: [] } apply minecraft:block/empty",
      "  when { OR: [{ powered: true }], facing: south } apply minecraft:block/mixed",
      "}",
      "let ordinary = { facing: still_ordinary }"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);
    const undefinedDiagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol"
    );

    assert.strictEqual(undefinedDiagnostics.length, 1);
    assert.ok(undefinedDiagnostics[0].message.includes("still_ordinary"));
    assert.ok(codes.includes("rsgl.invalidBlockstateLogicalCondition"));
    assert.ok(codes.includes("rsgl.mixedBlockstateWhenCondition"));
  });

  it("checks the closed model-object/list/random domain and records Json provenance", () => {
    const source = [
      "let escaped: Json = { model: minecraft:block/escaped, future_field: true }",
      "let closed = { model: minecraft:block/closed, misspelled: true }",
      "blockstate variants apply_values {",
      "  {}: minecraft:block/direct y=90 uvlock=true",
      "  {}: { model: minecraft:block/object, x: 180 }",
      "  {}: [{ model: minecraft:block/a }, { model: minecraft:block/b }]",
      "  {}: random [minecraft:block/a weight=2, { model: minecraft:block/b }]",
      "  {}: escaped",
      "  {}: closed",
      "  {}: {}",
      "  {}: []",
      "  {}: [[{ model: minecraft:block/nested }]]",
      "  {}: random []",
      "  {}: random [[{ model: minecraft:block/nested_random }]]",
      "  {}: { model: minecraft:block/property_head } y=90",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.unknownBlockstateModelField").length, 1);
    assert.ok(codes.includes("rsgl.missingBlockstateModel"));
    assert.ok(codes.includes("rsgl.emptyBlockstateModelList"));
    assert.ok(codes.includes("rsgl.nestedBlockstateModelList"));
    assert.ok(codes.includes("rsgl.emptyBlockstateRandom"));
    assert.ok(codes.includes("rsgl.invalidBlockstateApplyHead"));

    const facts = Array.from(model.blockstateApplyFacts ?? []);
    const escaped = facts.find(([node]) => source.slice(node.head.range.start, node.head.range.end) === "escaped");
    const closed = facts.find(([node]) => source.slice(node.head.range.start, node.head.range.end) === "closed");
    assert.strictEqual(escaped?.[1].unknownFields, "preserveExplicitJson");
    assert.strictEqual(closed?.[1].unknownFields, "reject");
  });

  it("reports concrete opposite template modes as blockstate mode conflicts", () => {
    const model = bindRsglModule(parseRsgl([
      "template variantsPart() -> variants { {}: minecraft:block/variant }",
      "template multipartPart() -> multipart { apply minecraft:block/part }",
      "blockstate variants good { use variantsPart() }",
      "blockstate variants wrong_variants { use multipartPart() }",
      "blockstate multipart wrong_multipart { use variantsPart() }",
      "blockstate legacy_conflict { use variantsPart()\nuse multipartPart() }"
    ].join("\n")));
    const conflicts = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.blockstateModeConflict"
    );

    assert.strictEqual(conflicts.length, 3);
    assert.ok(!model.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.templateOutputDialectMismatch"
      && (diagnostic.message.includes("variantsPart") || diagnostic.message.includes("multipartPart"))
    ));
    assert.strictEqual(
      model.legacyBlockstateRoots?.[0]?.uses[0]?.callerContext?.kind === "blockstateRoot"
        ? model.legacyBlockstateRoots[0].uses[0].callerContext.mode
        : undefined,
      "neutral"
    );
  });

  it("reports one precise conflict for an opposite legacy wrapper in a concrete mode", () => {
    const source = [
      "blockstate variants wrong_wrapper {",
      "  multipart { apply minecraft:block/part }",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const conflicts = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.blockstateModeConflict"
    );

    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(
      source.slice(conflicts[0].range.start, conflicts[0].range.end),
      "multipart"
    );
  });

  it("infers wrapper-less legacy mode from a unique static root merge", () => {
    const source = [
      "blockstate inferred_merge {",
      "  merge upsert { variants: {} }",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const record = model.legacyBlockstateRoots?.[0];

    assert.deepStrictEqual(record?.directModes, ["variants"]);
  });

  it("stores compact source-position scopes for post-link blockstate rechecks", () => {
    const lets = Array.from({ length: 200 }, (_, index) => `  let local${index} = "value${index}"`);
    const model = bindRsglModule(parseRsgl([
      "blockstate variants compact_scopes {",
      ...lets,
      "  { state: local199 }: minecraft:block/value",
      "}"
    ].join("\n")));
    const contextualScope = model.blockstateContextualExpressionRecords?.[0]?.scope;
    const applyScope = model.blockstateApplyRecords?.[0]?.scope;

    assert.deepStrictEqual(Array.from(contextualScope?.symbols.keys() ?? []), ["local199"]);
    assert.strictEqual(applyScope?.symbols.size, 0);
  });

  it("rechecks bare import-all re-exports with final types and lexical shadowing", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const mainSource = [
      "import \"./barrel.rsgl\"",
      "blockstate variants linked {",
      "  {}: linkedJson",
      "  {}: plainClosed",
      "  let linkedClosed: Json = { model: minecraft:block/local, local_future: true }",
      "  {}: linkedClosed",
      "}",
      "blockstate inferred { use linkedVariants() }"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: barrelFile, module: parseRsgl("export * from \"./definitions.rsgl\"") },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "let linkedJson: Json = { model: minecraft:block/json, future_field: true }",
          "let plainClosed = { model: minecraft:block/closed, misspelled: true }",
          "let linkedClosed = { model: minecraft:block/imported, misspelled: true }",
          "template linkedVariants() -> variants { {}: minecraft:block/linked }",
          "export { linkedJson, plainClosed, linkedClosed, linkedVariants }"
        ].join("\n"))
      }
    ]);
    const mainModel = program.models.find(model => model.fileName === mainFile);
    const mainDiagnostics = program.fileDiagnostics.filter(diagnostic => diagnostic.fileName === mainFile);
    const policies = Array.from(mainModel?.blockstateApplyFacts?.values() ?? [])
      .map(fact => fact.unknownFields);

    assert.strictEqual(
      mainDiagnostics.filter(diagnostic => diagnostic.code === "rsgl.unknownBlockstateModelField").length,
      1
    );
    assert.strictEqual(policies.filter(policy => policy === "preserveExplicitJson").length, 2);
    assert.strictEqual(policies.filter(policy => policy === "reject").length, 1);
    assert.strictEqual(
      mainModel?.legacyBlockstateRoots?.[0]?.uses[0]?.callerContext?.kind === "blockstateRoot"
        ? mainModel.legacyBlockstateRoots[0].uses[0].callerContext.mode
        : undefined,
      "variants"
    );
    assert.ok(!mainDiagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol"
      || diagnostic.code === "rsgl.templateOutputDialectMismatch"
    ));
  });

  it("rechecks imported selectors, computed keys, and multipart conditions after linking", () => {
    const mainFile = path.resolve("pack", "contextual-main.rsgl");
    const definitionsFile = path.resolve("pack", "contextual-definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { scalar, objectValue } from \"./contextual-definitions.rsgl\"",
          "blockstate variants imported_selector {",
          "  (scalar): minecraft:block/a",
          "  { [objectValue]: north }: minecraft:block/b",
          "}",
          "blockstate multipart imported_condition {",
          "  when scalar apply minecraft:block/c",
          "}"
        ].join("\n"))
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "let scalar = \"north\"",
          "let objectValue = {}",
          "export { scalar, objectValue }"
        ].join("\n"))
      }
    ]);
    const codes = program.fileDiagnostics
      .filter(diagnostic => diagnostic.fileName === mainFile)
      .map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.blockstateSelectorMustBeObject"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorKey"));
    assert.ok(codes.includes("rsgl.invalidBlockstateCondition"));
  });
});
