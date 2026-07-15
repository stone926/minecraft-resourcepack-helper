import * as assert from "node:assert";
import * as path from "node:path";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram } from "../../src/semantic";

describe("RSGL blockstate semantics", () => {
  it("checks case selectors contextually without changing ordinary object expressions", () => {
    const source = [
      "let invalidKey = {}",
      "let invalidValue = {}",
      "let north = \"south\"",
      "let shorthandValue = \"ordinary\"",
      "let ordinary = { facing: custom_enum_literal, shorthandValue }",
      "blockstate variants selectors {",
      "  case { facing: custom_enum_literal } => minecraft:block/one",
      "  case { facing: north, \"facing\": south } => minecraft:block/two",
      "  case { [invalidKey]: north } => minecraft:block/three",
      "  case { facing: invalidValue } => minecraft:block/four",
      "  case \"north\" => minecraft:block/five",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    const ordinaryUndefined = model.diagnostics.find(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol" && diagnostic.message.includes("custom_enum_literal")
    );
    assert.ok(ordinaryUndefined);
    assert.ok(codes.includes("rsgl.duplicateBlockstateSelectorProperty"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorKey"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorValue"));
    assert.ok(codes.includes("rsgl.blockstateSelectorMustBeObject"));
    assert.ok(codes.includes("rsgl.blockstateEnumLiteralShadowed"));
  });

  it("checks first-class StatePredicate operators and rejects raw condition objects", () => {
    const model = bindRsglModule(parseRsgl([
      "blockstate multipart conditions {",
      "  part when $state.facing == north => minecraft:block/north",
      "  part when $state.axis in [x, z] => minecraft:block/axis",
      "  part when $state.power in [] => minecraft:block/empty",
      "  part when { OR: [{ powered: true }] } => minecraft:block/raw",
      "  part when $state.north == $state.south => minecraft:block/runtime_rhs",
      "  part when true => minecraft:block/not_a_predicate",
      "}",
      "let ordinary = { facing: still_ordinary }"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(model.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol" && diagnostic.message.includes("still_ordinary")
    ));
    assert.ok(codes.includes("rsgl.emptyBlockstatePredicateMembership"));
    assert.ok(codes.includes("rsgl.invalidBlockstatePredicate"));
    assert.ok(codes.includes("rsgl.invalidBlockstatePredicateComparison"));
  });

  it("reserves $state against value and parameter bindings", () => {
    const model = bindRsglModule(parseRsgl([
      "let $state = { north: 5 }",
      "template shadow($state: Json) -> multipart {",
      "  part when $state.north == true => minecraft:block/template",
      "}",
      "template $state() -> variants { case * => minecraft:block/invalid_name }",
      "blockstate multipart reserved_state {",
      "  part when $state.north == true => minecraft:block/root",
      "}"
    ].join("\n")));

    assert.strictEqual(
      model.diagnostics.filter(diagnostic =>
        diagnostic.code === "rsgl.reservedBlockstateStateNamespace"
      ).length,
      3
    );
  });

  it("keeps random choice bindings out of the surrounding semantic scope", () => {
    const model = bindRsglModule(parseRsgl([
      "blockstate multipart choice_scope {",
      "  part always => random {",
      "    let leaked: StatePredicate = $state.north == true",
      "    option minecraft:block/first",
      "  }",
      "  part when leaked => minecraft:block/second",
      "}"
    ].join("\n")));

    assert.ok(model.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol"
      && diagnostic.message.includes("leaked")
    ));
  });

  it("checks the closed ModelSpec and random option domains and records ModelSpec scopes", () => {
    const source = [
      "let model: ModelId = minecraft:block/direct",
      "let x = 90",
      "let spreadOptions = { y: 90 }",
      "let field = \"z\"",
      "blockstate variants model_specs {",
      "  case { kind: direct } => model with { x, uvlock: true }",
      "  case { kind: random } => random {",
      "    option minecraft:block/a weight 2",
      "    option minecraft:block/b with { y: 180 }",
      "  }",
      "  case { kind: unknown } => minecraft:block/c with { future: true }",
      "  case { kind: spread } => minecraft:block/d with { ...spreadOptions }",
      "  case { kind: computed } => minecraft:block/e with { [field]: 90 }",
      "  case { kind: weight } => minecraft:block/f with { weight: 2 }",
      "  case { kind: rotation } => minecraft:block/g with { x: 45 }",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    for (const expected of [
      "rsgl.unknownBlockstateModelField",
      "rsgl.invalidBlockstateModelOptionsSpread",
      "rsgl.invalidBlockstateModelOption",
      "rsgl.blockstateWeightInvalidContext",
      "rsgl.invalidBlockstateRotation"
    ]) {
      assert.ok(codes.includes(expected), `Missing ${expected}`);
    }

    const records = model.blockstateModelSpecRecords ?? [];
    const heads = records.map(record =>
      source.slice(record.node.model.range.start, record.node.model.range.end)
    );
    assert.ok(heads.includes("model"));
    assert.ok(heads.includes("minecraft:block/a"));
    assert.ok(heads.includes("minecraft:block/b"));
    const direct = records.find(record =>
      source.slice(record.node.model.range.start, record.node.model.range.end) === "model"
    );
    assert.ok(direct);
    assert.deepStrictEqual(
      direct.node.options?.properties.map(property =>
        source.slice(property.range.start, property.range.end)
      ),
      ["x", "uvlock: true"]
    );
  });

  it("reports variants, multipart, and choice template output mismatches", () => {
    const model = bindRsglModule(parseRsgl([
      "template variantsPart() -> variants { case * => minecraft:block/variant }",
      "template multipartPart() -> multipart { part always => minecraft:block/part }",
      "template choicePart() -> choice { option minecraft:block/choice }",
      "blockstate variants good { use variantsPart() }",
      "blockstate multipart good_parts { use multipartPart() }",
      "blockstate variants good_choice { case * => random { use choicePart() } }",
      "blockstate variants wrong_variants { use multipartPart() }",
      "blockstate multipart wrong_multipart { use variantsPart() }",
      "blockstate variants wrong_choice { use choicePart() }"
    ].join("\n")));
    const mismatches = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.templateOutputDialectMismatch"
    );

    assert.strictEqual(mismatches.length, 3);
    assert.ok(mismatches.some(diagnostic => diagnostic.message.includes("variantsPart")));
    assert.ok(mismatches.some(diagnostic => diagnostic.message.includes("multipartPart")));
    assert.ok(mismatches.some(diagnostic => diagnostic.message.includes("choicePart")));
  });

  it("stores compact source-position scopes for post-link selector and ModelSpec rechecks", () => {
    const lets = Array.from({ length: 200 }, (_, index) => `  let local${index} = "value${index}"`);
    const model = bindRsglModule(parseRsgl([
      "blockstate variants compact_scopes {",
      ...lets,
      "  let selectedModel: ModelId = minecraft:block/value",
      "  case { state: local199 } => selectedModel",
      "}"
    ].join("\n")));
    const contextualScope = model.blockstateContextualExpressionRecords?.[0]?.scope;
    const modelSpecScope = model.blockstateModelSpecRecords?.[0]?.scope;

    assert.deepStrictEqual(Array.from(contextualScope?.symbols.keys() ?? []), ["local199"]);
    assert.deepStrictEqual(Array.from(modelSpecScope?.symbols.keys() ?? []), ["selectedModel"]);
  });

  it("rechecks bare import-all ModelSpecs with final types and lexical shadowing", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const barrelFile = path.resolve("pack", "barrel.rsgl");
    const definitionsFile = path.resolve("pack", "definitions.rsgl");
    const mainSource = [
      "import \"./barrel.rsgl\"",
      "blockstate variants linked {",
      "  let linkedModel: ModelId = minecraft:block/local",
      "  case { kind: shadowed } => linkedModel",
      "  case { kind: invalid } => plainNumber",
      "}",
      "blockstate variants inferred { use linkedVariants() }"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: barrelFile, module: parseRsgl("export * from \"./definitions.rsgl\"") },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "let linkedModel: ModelId = minecraft:block/imported",
          "let plainNumber = 42",
          "template linkedVariants() -> variants { case * => minecraft:block/linked }",
          "export { linkedModel, plainNumber, linkedVariants }"
        ].join("\n"))
      }
    ]);
    const mainModel = program.models.find(model => model.fileName === mainFile);
    const mainDiagnostics = program.fileDiagnostics.filter(diagnostic => diagnostic.fileName === mainFile);

    assert.strictEqual(
      mainDiagnostics.filter(diagnostic => diagnostic.code === "rsgl.typeMismatch").length,
      1
    );
    const heads = (mainModel?.blockstateModelSpecRecords ?? []).map(record =>
      mainSource.slice(record.node.model.range.start, record.node.model.range.end)
    );
    assert.ok(heads.includes("linkedModel"));
    assert.ok(heads.includes("plainNumber"));
    const linkedUse = mainModel?.templateUses?.find(record =>
      mainSource.slice(record.expression.range.start, record.expression.range.end).startsWith("linkedVariants")
    );
    assert.strictEqual(
      linkedUse?.callerContext?.kind === "blockstateRoot"
        ? linkedUse.callerContext.mode
        : undefined,
      "variants"
    );
    assert.ok(!mainDiagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.undefinedSymbol"
      || diagnostic.code === "rsgl.templateOutputDialectMismatch"
    ));
  });

  it("rechecks imported selectors, computed keys, and StatePredicate values after linking", () => {
    const mainFile = path.resolve("pack", "contextual-main.rsgl");
    const definitionsFile = path.resolve("pack", "contextual-definitions.rsgl");
    const program = bindRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { scalar, objectValue, attached } from \"./contextual-definitions.rsgl\"",
          "blockstate variants imported_selector {",
          "  case scalar => minecraft:block/a",
          "  case { [objectValue]: north } => minecraft:block/b",
          "}",
          "blockstate multipart imported_predicate {",
          "  part when scalar => minecraft:block/c",
          "  part when attached => minecraft:block/d",
          "}"
        ].join("\n"))
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "let scalar = \"north\"",
          "let objectValue = {}",
          "let attached: StatePredicate = $state.north == true",
          "export { scalar, objectValue, attached }"
        ].join("\n"))
      }
    ]);
    const codes = program.fileDiagnostics
      .filter(diagnostic => diagnostic.fileName === mainFile)
      .map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.blockstateSelectorMustBeObject"));
    assert.ok(codes.includes("rsgl.invalidBlockstateSelectorKey"));
    assert.ok(codes.includes("rsgl.invalidBlockstatePredicate"));
    assert.strictEqual(
      codes.filter(code => code === "rsgl.invalidBlockstatePredicate").length,
      1,
      "The imported StatePredicate should remain valid after linking."
    );
  });
});
