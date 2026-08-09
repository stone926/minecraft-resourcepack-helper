import * as assert from "node:assert/strict";
import { bindRsglArgumentSlots } from "../../src/arguments";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglModule,
  formatType,
  isAssignable,
  type RsglSemanticModel,
  type RsglType
} from "../../src/semantic";
import {
  createBuiltinSymbols,
  getBuiltinSignature
} from "../../src/semantic/builtins";

describe("RSGL typed collection semantics", () => {
  it("publishes generic signatures and one shared positional-only rest contract", () => {
    const symbols = new Map(createBuiltinSymbols().map(symbol => [symbol.name, symbol]));
    const concat = symbols.get("concat")?.signature;
    const mergeObjects = getBuiltinSignature("mergeObjects");

    assert.deepStrictEqual(concat?.typeParameters?.map(parameter => parameter.name), ["T"]);
    assert.strictEqual(concat?.parameters[0].rest, true);
    assert.strictEqual(mergeObjects?.parameters[0].rest, true);
    assert.strictEqual(symbols.get("has")?.signature?.parameters[0].type.kind, "TypeParameter");

    const parameters = concat?.parameters ?? [];
    interface Slot { name?: string; value: number }
    const zero = bindRsglArgumentSlots(parameters, [] as Slot[], arg => arg.name);
    const one = bindRsglArgumentSlots(parameters, [{ value: 1 }] as Slot[], arg => arg.name);
    const many = bindRsglArgumentSlots(
      parameters,
      [{ value: 1 }, { value: 2 }, { value: 3 }] as Slot[],
      arg => arg.name
    );
    const named = bindRsglArgumentSlots(
      parameters,
      [{ name: "sources", value: 1 }] as Slot[],
      arg => arg.name
    );

    assert.strictEqual(zero.restAssignments.length, 0);
    assert.strictEqual(zero.missingParameters.length, 0);
    assert.deepStrictEqual(one.restAssignments.map(assignment => assignment.arg.value), [1]);
    assert.deepStrictEqual(many.restAssignments.map(assignment => assignment.arg.value), [1, 2, 3]);
    assert.deepStrictEqual(named.issues.map(issue => issue.kind), ["namedRest"]);
    assert.strictEqual(named.restAssignments.length, 0);
  });

  it("publishes flat with a List source and optional Number depth", () => {
    const signature = getBuiltinSignature("flat");

    assert.deepStrictEqual(signature?.typeParameters?.map(parameter => parameter.name), ["T"]);
    assert.deepStrictEqual(
      signature?.parameters.map(parameter => ({
        name: parameter.name,
        type: formatType(parameter.type),
        optional: parameter.optional
      })),
      [
        { name: "source", type: "List<T>", optional: false },
        { name: "depth", type: "Number", optional: true }
      ]
    );
    assert.strictEqual(formatType(signature?.returnType ?? { kind: "Unknown" }), "List<T>");
  });

  it("infers Never for empty lists while using contextual collection types", () => {
    const model = bind([
      "let empty = []",
      "let contextual: List<String> = []",
      "let emptyConcat: List<String> = concat()",
      "let ids: List<ModelId> = concat([], [\"minecraft:block/stone\"])",
      "let mappedIds: List<ModelId> = map([\"minecraft:block/stone\"], id => id)"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(symbolType(model, "empty").elementType?.kind, "Never");
    assert.strictEqual(formatType(symbolType(model, "contextual")), "List<String>");
    assert.strictEqual(formatType(symbolType(model, "emptyConcat")), "List<String>");
    assert.strictEqual(formatType(symbolType(model, "ids")), "List<ModelId>");
    assert.strictEqual(formatType(symbolType(model, "mappedIds")), "List<ModelId>");
  });

  it("infers map/filter/flatMap over Lists and Number Ranges", () => {
    const model = bind([
      "let mapped = map([1, 2], value => `${value}`)",
      "let filtered = filter(1..3, value => value > 1)",
      "let flattened = flatMap([1, 2], value => [value, value + 1])"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "mapped")), "List<String>");
    assert.strictEqual(formatType(symbolType(model, "filtered")), "List<Number>");
    assert.match(formatType(symbolType(model, "flattened")), /^List<.*Number/u);
    assertNoTypeParameter(symbolType(model, "mapped"));
    assertNoTypeParameter(symbolType(model, "filtered"));
    assertNoTypeParameter(symbolType(model, "flattened"));
  });

  it("infers flat precisely for static depths and conservatively for dynamic depth", () => {
    const model = bind([
      "let nested = [[[[1]]], [[2]], [true], 4]",
      "let infinite = flat(nested)",
      "let zero = flat(nested, 0)",
      "let one = flat(nested, 1)",
      "let two = flat(nested, 2)",
      "let fractional = flat(nested, 1.9)",
      "let negative = flat(nested, -2.4)",
      "let selectedDepth = flat(nested, true ? 0 : 2)",
      "let nestedRange = flat([1..2])",
      "let preservedRange = flat([1..2], 0)",
      "let dynamicDepth: Number = 1",
      "let dynamic = flat(nested, dynamicDepth)"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "infinite")), "List<true | 1 | 2 | 4>");
    assert.strictEqual(formatType(symbolType(model, "zero")), formatType(symbolType(model, "nested")));
    assert.strictEqual(
      formatType(symbolType(model, "one")),
      "List<true | List<List<1>> | List<2> | 4>"
    );
    assert.strictEqual(formatType(symbolType(model, "two")), "List<true | List<1> | 2 | 4>");
    assert.strictEqual(formatType(symbolType(model, "fractional")), formatType(symbolType(model, "one")));
    assert.strictEqual(formatType(symbolType(model, "negative")), formatType(symbolType(model, "zero")));
    for (const possible of ["zero", "two"]) {
      assert.strictEqual(
        isAssignable(
          symbolType(model, "selectedDepth").elementType ?? { kind: "Unknown" },
          symbolType(model, possible).elementType ?? { kind: "Unknown" }
        ),
        true,
        `A finite depth union must include the element shape from '${possible}'.`
      );
    }
    assert.strictEqual(formatType(symbolType(model, "nestedRange")), "List<Number>");
    assert.strictEqual(formatType(symbolType(model, "preservedRange")), "List<Range>");

    const dynamic = symbolType(model, "dynamic");
    assert.strictEqual(dynamic.kind, "List");
    assert.strictEqual(dynamic.elementType?.kind, "Union");
    for (const possible of ["zero", "one", "two", "infinite"]) {
      assert.strictEqual(
        isAssignable(
          dynamic.elementType ?? { kind: "Unknown" },
          symbolType(model, possible).elementType ?? { kind: "Unknown" }
        ),
        true,
        `Dynamic flat depth must include every element shape from '${possible}'.`
      );
    }
    for (const name of [
      "infinite",
      "zero",
      "one",
      "two",
      "fractional",
      "negative",
      "selectedDepth",
      "nestedRange",
      "preservedRange",
      "dynamic"
    ]) {
      assertNoTypeParameter(symbolType(model, name));
    }
  });

  it("propagates contextual leaf types through literal flat inputs", () => {
    const model = bind([
      "let rawNested = [[\"minecraft:block/stone\"]]",
      "let mixed = [[model_id(\"minecraft:block/a\")], [\"minecraft:block/b\"]]",
      "let direct: List<ModelId> = flat([\"minecraft:block/stone\"])",
      "let nested: List<ModelId> = flat([[\"minecraft:block/stone\"]])",
      "let variable: List<ModelId> = flat(rawNested)",
      "let mixedIds: List<ModelId> = flat(mixed)",
      "let fromCall: List<ModelId> = flat(asList([\"minecraft:block/stone\"]))",
      "let depthZero: List<ModelId> = flat([\"minecraft:block/stone\"], 0)",
      "let numbers: List<Number> = flat([[1..2]])"
    ]);

    assert.deepStrictEqual(codes(model), []);
    for (const name of ["direct", "nested", "variable", "mixedIds", "fromCall", "depthZero"]) {
      assert.strictEqual(formatType(symbolType(model, name)), "List<ModelId>");
    }
    assert.strictEqual(formatType(symbolType(model, "numbers")), "List<Number>");

    const direct = model.module.statements.find(statement =>
      statement.kind === "LetDecl" && statement.name?.text === "direct");
    if (
      !direct
      || direct.kind !== "LetDecl"
      || direct.value.kind !== "CallExpr"
      || direct.value.args[0]?.value.kind !== "ListExpr"
    ) {
      assert.fail("Expected direct flat call with a List literal source.");
    }
    const leaf = direct.value.args[0].value.elements[0];
    assert.ok(leaf && leaf.kind !== "ListSpread");
    assert.strictEqual(
      formatType(model.resolvedExpectedTypes.get(leaf) ?? { kind: "Unknown" }),
      "ModelId"
    );
    const variable = model.module.statements.find(statement =>
      statement.kind === "LetDecl" && statement.name?.text === "variable");
    assert.ok(variable && variable.kind === "LetDecl");
    assert.strictEqual(
      formatType(model.resolvedExpectedTypes.get(variable.value) ?? { kind: "Unknown" }),
      "List<ModelId>"
    );

    const invalid = bind([
      "let depth: Number = 0",
      "let tooShallow: List<ModelId> = flat([[\"minecraft:block/stone\"]], 0)",
      "let dynamic: List<ModelId> = flat([[\"minecraft:block/stone\"]], depth)"
    ]);
    assert.deepStrictEqual(codes(invalid), ["rsgl.typeMismatch", "rsgl.typeMismatch"]);
  });

  it("rejects non-List flat sources and non-Number depths without cascades", () => {
    const model = bind([
      "let rangeSource = flat(1..3)",
      "let scalarSource = flat(1)",
      "let recordSource = flat({ value: 1 })",
      "let invalidDepth = flat([1], \"deep\")"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.collectionExpected",
      "rsgl.collectionExpected",
      "rsgl.collectionExpected",
      "rsgl.typeMismatch"
    ]);
  });

  it("normalizes asList inputs to one list layer without flattening nested lists", () => {
    const model = bind([
      "let fromList = asList([1, 2])",
      "let fromRange = asList(1..2)",
      "let fromScalar = asList(\"one\")",
      "let fromUnion = asList(true ? [1] : \"two\")",
      "let existing = [[1], [2]]",
      "let nested = asList(existing)"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(symbolType(model, "fromList").kind, "List");
    assert.strictEqual(formatType(symbolType(model, "fromRange")), "List<Number>");
    assert.match(formatType(symbolType(model, "fromScalar")), /^List<(?:.*String|"one")/u);

    const union = symbolType(model, "fromUnion");
    assert.strictEqual(union.kind, "List");
    assert.match(formatType(union.elementType ?? { kind: "Unknown" }), /Number|1/u);
    assert.match(formatType(union.elementType ?? { kind: "Unknown" }), /String|"two"/u);

    const nested = symbolType(model, "nested");
    assert.strictEqual(nested.kind, "List");
    assert.strictEqual(nested.elementType?.kind, "List", "asList must not flatten an existing list");
    assert.match(formatType(nested.elementType ?? { kind: "Unknown" }), /1/u);
    assert.match(formatType(nested.elementType ?? { kind: "Unknown" }), /2/u);
    for (const name of ["fromList", "fromRange", "fromScalar", "fromUnion", "nested"]) {
      assertNoTypeParameter(symbolType(model, name));
    }
  });

  it("contextually types asList and limits length to Lists and Ranges", () => {
    const valid = bind([
      "let ids: List<ModelId> = asList(\"minecraft:block/stone\")",
      "let listLength = length([1, 2])",
      "let rangeLength = length(1..3)",
      "let source: List<Number> | Range<Number> = true ? [1] : 1..3",
      "let unionLength = length(source)"
    ]);

    assert.deepStrictEqual(codes(valid), []);
    assert.strictEqual(formatType(symbolType(valid, "ids")), "List<ModelId>");
    for (const name of ["listLength", "rangeLength", "unionLength"]) {
      assert.strictEqual(symbolType(valid, name).kind, "Number");
      assertNoTypeParameter(symbolType(valid, name));
    }

    const invalid = bind([
      "let stringLength = length(\"abc\")",
      "let objectLength = length({ value: 1 })",
      "let objectList = asList({ value: 1 })",
      "let wrongContext: List<String> = asList(1..2)"
    ]);
    assert.deepStrictEqual(codes(invalid), [
      "rsgl.collectionExpected",
      "rsgl.collectionExpected",
      "rsgl.collectionExpected",
      "rsgl.typeMismatch"
    ]);
  });

  it("preserves List-union spread element types", () => {
    const model = bind([
      "let combined = [...(true ? [1] : [\"one\"])]"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.match(formatType(symbolType(model, "combined")), /Number|1/u);
    assert.match(formatType(symbolType(model, "combined")), /String|"one"/u);
  });

  it("reports strict predicate, mapper iterable, and unresolved collection inference errors", () => {
    const model = bind([
      "let badPredicate = filter([1], value => value)",
      "let badFlatMap = flatMap([1], value => value)",
      "let emptyConcat = concat()",
      "let emptySource = concat([])",
      "let unresolvedFlatMap = flatMap([], value => [])",
      "let namedRest = concat(sources: [1])"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.predicateMustReturnBoolean",
      "rsgl.mapperReturnTypeMismatch",
      "rsgl.cannotInferCollectionType",
      "rsgl.cannotInferCollectionType",
      "rsgl.cannotInferCollectionType",
      "rsgl.namedRestArgumentNotSupported"
    ]);
  });

  it("keeps mapper purity checks and collection shape diagnostics precise", () => {
    const model = bind([
      "let impure = map([\"*.json\"], pattern => glob(pattern))",
      "let badConcat = concat([1], true)",
      "let badMerge = mergeObjects({ value: 1 }, [2])"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.lambdaImpureCall",
      "rsgl.collectionExpected",
      "rsgl.collectionExpected"
    ]);
  });

  it("reports one root-cause diagnostic for contextual collection mismatches", () => {
    const contextual = bind([
      "let concatResult: List<String> = concat([1])",
      "let joinResult = join([1], \",\")"
    ]);
    const scalar = bind([
      "let invalid = concat(1)"
    ]);

    assert.deepStrictEqual(codes(contextual), [
      "rsgl.typeMismatch",
      "rsgl.typeMismatch"
    ]);
    assert.deepStrictEqual(codes(scalar), ["rsgl.collectionExpected"]);
  });

  it("unifies every concat rest argument without leaking TypeParameter", () => {
    const model = bind([
      "let one = concat([1])",
      "let many = concat([], [1], [\"two\"], 3..4)"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.match(formatType(symbolType(model, "one")), /^List<.*Number|List<1>/u);
    assert.match(formatType(symbolType(model, "many")), /Number/u);
    assert.match(formatType(symbolType(model, "many")), /String|"two"/u);
    assertNoTypeParameter(symbolType(model, "one"));
    assertNoTypeParameter(symbolType(model, "many"));
  });

  it("derives closed, open, and optional record projections precisely", () => {
    const model = bind([
      "type Closed = { alpha: String; count?: Number }",
      "let closed: Closed = { alpha: \"a\" }",
      "let closedKeys = keys(closed)",
      "let closedValues = values(closed)",
      "let closedEntries = entries(closed)",
      "let dynamicKey = \"future\"",
      "let open = { [dynamicKey]: 1 }",
      "let openKeys = keys(open)",
      "let openValues = values(open)",
      "let openEntries = entries(open)",
      "let mixed = { fixed: \"known\", [dynamicKey]: 1 }",
      "let mixedValues = values(mixed)",
      "let mixedEntries = entries(mixed)"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "closedKeys")), "List<\"alpha\" | \"count\">");
    assert.strictEqual(formatType(symbolType(model, "closedValues")), "List<Number | String>");
    assert.doesNotMatch(formatType(symbolType(model, "closedEntries")), /Missing/u);
    assert.strictEqual(formatType(symbolType(model, "openKeys")), "List<String>");
    assert.match(formatType(symbolType(model, "openValues")), /^List<1>|List<Number>/u);
    assert.match(formatType(symbolType(model, "openEntries")), /key: String/u);
    assert.match(formatType(symbolType(model, "mixedValues")), /String|"known"/u);
    assert.match(formatType(symbolType(model, "mixedValues")), /Number|1/u);
    assert.match(formatType(symbolType(model, "mixedEntries")), /String|"known"/u);
    assert.match(formatType(symbolType(model, "mixedEntries")), /Number|1/u);
  });

  it("models shallow mergeObjects override and later optional fallback semantics", () => {
    const model = bind([
      "type Earlier = { value: String; stable: Boolean }",
      "type Later = { value?: Number; added?: String }",
      "type EmptyCompatible = { value?: String; stable?: Boolean }",
      "let earlier: Earlier = { value: \"old\", stable: true }",
      "let later: Later = {}",
      "let merged = mergeObjects(earlier, later)",
      "let overridden = mergeObjects(earlier, { value: 1 })",
      "let expectedEmpty: EmptyCompatible = mergeObjects()"
    ]);

    assert.deepStrictEqual(codes(model), []);
    const merged = symbolType(model, "merged");
    assert.strictEqual(formatType(merged.properties?.get("value")?.type ?? { kind: "Unknown" }), "Number | String");
    assert.strictEqual(merged.properties?.get("value")?.optional, false);
    assert.strictEqual(merged.properties?.get("stable")?.optional, false);
    assert.strictEqual(merged.properties?.get("added")?.optional, true);
    assert.match(formatType(symbolType(model, "overridden").properties?.get("value")?.type ?? { kind: "Unknown" }), /Number|1/u);
    assert.strictEqual(formatType(symbolType(model, "expectedEmpty")), "{ value?: String, stable?: Boolean }");
    assertNoTypeParameter(merged);
  });

  it("propagates contextual record types into every mergeObjects operand", () => {
    const model = bind([
      "type Output = { model: ModelId; nested: { textures: List<TextureId> } }",
      "let single: { model: ModelId } = mergeObjects({ model: \"block/stone\" })",
      "let many: Output = mergeObjects(",
      "  { model: \"block/stone\" },",
      "  { nested: { textures: [\"block/stone\", \"block/dirt\"] } }",
      ")"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "single")), "{ model: ModelId }");
    assert.match(formatType(symbolType(model, "many")), /textures: List<TextureId>/u);
  });

  it("keeps an empty mergeObjects result structurally empty under context", () => {
    const model = bind([
      "let required: { model: ModelId } = mergeObjects()",
      "let optional: { model?: ModelId } = mergeObjects()"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.typeMismatch"]);
    assert.strictEqual(formatType(symbolType(model, "optional")), "{ model?: ModelId }");
  });

  it("bounds mergeObjects union composition during every inference step", () => {
    const operands = Array.from({ length: 17 }, (_, index) =>
      `(true ? { field${index}: ${index * 2} } : { field${index}: ${index * 2 + 1} })`
    );
    const model = bind([
      `let merged = mergeObjects(${operands.join(", ")})`
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.unionWidened"]);
    const merged = symbolType(model, "merged");
    assert.ok(merged.kind === "Object" || merged.kind === "Union");
    assert.ok((merged.options?.length ?? 1) <= 128);
  });

  it("bounds object-spread union composition during every inference step", () => {
    const spreads = Array.from({ length: 17 }, (_, index) =>
      `...(true ? { field${index}: ${index * 2} } : { field${index}: ${index * 2 + 1} })`
    );
    const model = bind([
      `let merged = { ${spreads.join(", ")} }`
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.unionWidened"]);
    const merged = symbolType(model, "merged");
    assert.ok(merged.kind === "Object" || merged.kind === "Union");
    assert.ok((merged.options?.length ?? 1) <= 128);
  });

  it("types list/object spread in source order and propagates expected record fields", () => {
    const model = bind([
      "let list = [0, ...[1, 2], \"tail\"]",
      "let object = { before: 0, ...{ overridden: \"old\" }, overridden: 1, after: true }",
      "type Output = { model: ModelId; label: String }",
      "let output: Output = { ...{ model: \"minecraft:block/stone\" }, label: \"ok\" }"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.match(formatType(symbolType(model, "list")), /Number|0|1|2/u);
    assert.match(formatType(symbolType(model, "list")), /String|"tail"/u);
    const object = symbolType(model, "object");
    assert.deepStrictEqual(Array.from(object.properties?.keys() ?? []), ["before", "overridden", "after"]);
    assert.match(formatType(object.properties?.get("overridden")?.type ?? { kind: "Unknown" }), /Number|1/u);
    assert.strictEqual(formatType(symbolType(model, "output")), "{ model: ModelId, label: String }");
  });

  it("does not duplicate a contextual spread element mismatch", () => {
    const model = bind([
      "type Output = { items: List<String> }",
      "let output: Output = { items: [...[1]] }"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.typeMismatch"]);
  });

  it("rejects non-collection spreads with dedicated diagnostics", () => {
    const model = bind([
      "let badList = [...1]",
      "let badObject = { ...true }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.invalidListSpread",
      "rsgl.invalidObjectSpread"
    ]);
  });

  it("keeps precise product record inference alongside the collection checker", () => {
    const model = bind([
      "let combinations = product({ row: [\"top\"], column: [1] })"
    ]);

    assert.deepStrictEqual(codes(model), []);
    const result = symbolType(model, "combinations");
    assert.strictEqual(result.kind, "List");
    assert.strictEqual(result.elementType?.kind, "Object");
    assert.match(formatType(result.elementType?.properties?.get("row")?.type ?? { kind: "Unknown" }), /String|"top"/u);
    assert.match(formatType(result.elementType?.properties?.get("column")?.type ?? { kind: "Unknown" }), /Number|1/u);
  });

  it("does not expose Never as a source-level named type", () => {
    const model = bind(["let value: Never = 1"]);

    assert.deepStrictEqual(codes(model), ["rsgl.unknownType"]);
  });
});

function bind(lines: string[]): RsglSemanticModel {
  return bindRsglModule(parseRsgl(lines.join("\n")));
}

function codes(model: RsglSemanticModel): string[] {
  return model.diagnostics.map(diagnostic => diagnostic.code);
}

function symbolType(model: RsglSemanticModel, name: string): RsglType {
  const type = model.scope.symbols.get(name)?.type;
  assert.ok(type, `Missing symbol '${name}'.`);
  return type;
}

function assertNoTypeParameter(type: RsglType): void {
  assert.notStrictEqual(type.kind, "TypeParameter", formatType(type));
  if (type.elementType) {
    assertNoTypeParameter(type.elementType);
  }
  if (type.returnType) {
    assertNoTypeParameter(type.returnType);
  }
  type.parameters?.forEach(assertNoTypeParameter);
  type.options?.forEach(assertNoTypeParameter);
  type.properties?.forEach(property => assertNoTypeParameter(property.type));
  if (type.indexType) {
    assertNoTypeParameter(type.indexType);
  }
}
