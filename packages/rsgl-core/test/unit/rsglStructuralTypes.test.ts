import * as assert from "node:assert";
import { performance } from "node:perf_hooks";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglModule,
  combineRsglTypes,
  formatType,
  objectProperty,
  type RsglSemanticModel,
  type RsglType
} from "../../src/semantic";

describe("RSGL structural expression types", () => {
  it("infers heterogeneous list elements from every element", () => {
    const model = bind([
      "let values = [1, \"two\", false]",
      "let nested = [[1], [\"two\"], [true]]"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "values")), "List<false | 1 | \"two\">");
    assert.strictEqual(
      formatType(symbolType(model, "nested")),
      "List<List<true> | List<1> | List<\"two\">>"
    );
  });

  it("infers object member and static index result types", () => {
    const model = bind([
      "let settings = { label: \"stable\", retries: 2, enabled: true }",
      "let label = settings.label",
      "let retries = settings[\"retries\"]",
      "let enabled = settings.enabled"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(symbolType(model, "settings").kind, "Object");
    assert.strictEqual(symbolType(model, "label").kind, "String");
    assert.strictEqual(symbolType(model, "retries").kind, "Number");
    assert.strictEqual(symbolType(model, "enabled").kind, "Boolean");
  });

  it("retains table fields for member and index access", () => {
    const model = bind([
      "table palette { primary: \"red\", weight: 3 }",
      "let primary = palette.primary",
      "let weight = palette[\"weight\"]"
    ]);

    assert.deepStrictEqual(codes(model), []);
    const palette = symbolType(model, "palette");
    assert.strictEqual(palette.kind, "Object");
    assert.strictEqual(palette.properties?.get("primary")?.type.kind, "String");
    assert.strictEqual(palette.properties?.get("weight")?.type.kind, "Number");
    assert.strictEqual(symbolType(model, "primary").kind, "String");
    assert.strictEqual(symbolType(model, "weight").kind, "Number");
  });

  it("infers dynamic object indexes as the union of possible values", () => {
    const model = bind([
      "let key = \"first\"",
      "let values = { first: 1, second: \"two\" }",
      "let selected = values[key]",
      "let computed = { [key]: true }",
      "let dynamicSelected = computed[key]"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "selected")), "1");
    assert.strictEqual(symbolType(model, "computed").indexType?.kind, "Boolean");
    assert.strictEqual(symbolType(model, "dynamicSelected").kind, "Boolean");
  });

  it("keeps Missing in non-finite closed-record index results", () => {
    const model = bind([
      "let key: String = \"future\"",
      "let values = { first: 1, second: \"two\" }",
      "let selected = values[key]"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.optionalFieldMayBeMissing"]);
    const selected = symbolType(model, "selected");
    assert.strictEqual(selected.kind, "Union");
    assert.ok(selected.options?.some(option => option.kind === "Missing"));
    assert.match(model.diagnostics[0].message, /finite literal key type/);
  });

  it("binds list and range loop variables to their element types", () => {
    const model = bind([
      "for entry in [{ name: \"first\", count: 1 }, { name: \"second\", count: 2 }] {",
      "  let entryName = entry.name",
      "  let entryCount = entry.count",
      "}",
      "for position in 0..3 {",
      "  let numericPosition: Number = position",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "entryName")), "\"first\" | \"second\"");
    assert.strictEqual(formatType(symbolType(model, "entryCount")), "1 | 2");
    assert.strictEqual(symbolType(model, "numericPosition").kind, "Number");
    const entryReference = model.references.find(reference => reference.name === "entry");
    assert.strictEqual(entryReference?.symbol?.type.kind, "Union");
    const positionReference = model.references.find(reference => reference.name === "position");
    assert.strictEqual(positionReference?.symbol?.type.kind, "Number");
  });

  it("types object loop bindings by field name and supports local aliases", () => {
    const model = bind([
      "for { label, count: amount } in [{ count: 1, label: \"first\" }] {",
      "  let typedLabel: String = label",
      "  let typedAmount: Number = amount",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(symbolType(model, "typedLabel").kind, "String");
    assert.strictEqual(symbolType(model, "typedAmount").kind, "Number");
  });

  it("reports misspelled object loop fields at the binding property", () => {
    const source = [
      "for { name, models } in [{ name: \"fire\", modes: [\"normal\"] }] {",
      "  let selected = models",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));

    assert.deepStrictEqual(codes(model), ["rsgl.unknownRecordField"]);
    assert.strictEqual(
      source.slice(model.diagnostics[0].range.start, model.diagnostics[0].range.end),
      "models"
    );
    assert.match(model.diagnostics[0].message, /Did you mean 'modes'/);
  });

  it("reports optional object loop fields at the binding property", () => {
    const source = [
      "type Row = { name?: String }",
      "let rows: List<Row> = [{ name: \"first\" }, {}]",
      "for { name } in rows {",
      "  let selected = name",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));

    assert.deepStrictEqual(codes(model), ["rsgl.optionalFieldMayBeMissing"]);
    assert.strictEqual(
      source.slice(model.diagnostics[0].range.start, model.diagnostics[0].range.end),
      "name"
    );
  });

  it("reports one missing-field diagnostic across record union arms", () => {
    const model = bind([
      "for { models } in [{ modes: [1] }, { model: 2 }] {",
      "  let selected = models",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.unknownRecordField"]);
  });

  it("keeps named loop bindings permissive for Json and open records", () => {
    const model = bind([
      "let jsonRows: List<Json> = [{ known: 2 }]",
      "let dynamicKey: String = \"known\"",
      "let openRows = [{ [dynamicKey]: 3 }]",
      "for { future: jsonValue } in jsonRows { let selectedJson = jsonValue }",
      "for { future: openValue } in openRows { let selectedOpen = openValue }"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(symbolType(model, "selectedJson").kind, "Any");
    assert.strictEqual(symbolType(model, "selectedOpen").kind, "Number");
  });

  it("combines named loop field types across record unions", () => {
    const model = bind([
      "for { value } in [{ value: 1 }, { value: \"two\" }] {",
      "  let combined = value",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "combined")), "1 | \"two\"");
  });

  it("reports unknown members and invalid index operations at the access", () => {
    const source = [
      "let settings = { label: \"stable\" }",
      "let missing = settings.retries",
      "let typo = settings.lable",
      "let invalidListIndex = [1, 2][\"first\"]",
      "let outside = [1, 2][4]",
      "let invalidTarget = 1[0]"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));

    assert.deepStrictEqual(codes(model), [
      "rsgl.unknownRecordField",
      "rsgl.unknownRecordField",
      "rsgl.invalidIndexType",
      "rsgl.indexOutOfBounds",
      "rsgl.invalidIndexAccess"
    ]);
    assert.deepStrictEqual(
      model.diagnostics.map(diagnostic => source.slice(diagnostic.range.start, diagnostic.range.end)),
      ["retries", "lable", "\"first\"", "4", "0"]
    );
    assert.ok(model.diagnostics[1].message.includes("Did you mean 'label'?"));
  });

  it("reports non-iterable tables/scalars and invalid destructuring", () => {
    const model = bind([
      "table values { first: 1, second: 2 }",
      "for value in values { let tableValue = value }",
      "for value in 1 { let scalarValue = value }",
      "for { left, right } in [1, 2] { let invalidObjectPair = left }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.nonIterable",
      "rsgl.nonIterable",
      "rsgl.invalidLoopDestructuring"
    ]);
  });

  it("types explicit loop indexes as numbers in later dimensions and the body", () => {
    const model = bind([
      "for item at itemIndex in [\"a\"], other at otherIndex in [itemIndex] {",
      "  let firstIndex = itemIndex",
      "  let secondIndex = otherIndex",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(formatType(symbolType(model, "itemIndex")), "Number");
    assert.strictEqual(formatType(symbolType(model, "otherIndex")), "Number");
    assert.strictEqual(formatType(symbolType(model, "firstIndex")), "Number");
    assert.strictEqual(formatType(symbolType(model, "secondIndex")), "Number");

    const ownIterable = bind(["for item at itemIndex in [itemIndex + 0] {}"]);
    assert.ok(codes(ownIterable).includes("rsgl.undefinedSymbol"));

    const duplicate = bind(["for item at item in [1] {}"]);
    assert.ok(codes(duplicate).includes("rsgl.duplicateLoopBinding"));
  });

  it("reports one invalid-destructuring diagnostic across iterable union arms", () => {
    const model = bind([
      "let rows: List<Number> | List<String> = true ? [1] : [\"two\"]",
      "for { value } in rows { let selected = value }"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.invalidLoopDestructuring"]);
    assert.match(model.diagnostics[0].message, /Number \| String|String \| Number/);
  });

  it("widens oversized inferred literal unions within a bounded time", () => {
    const itemCount = 2_048;
    const source = `let values = [${Array.from({ length: itemCount }, (_, index) => index).join(",")}]`;
    const started = performance.now();
    const model = bindRsglModule(parseRsgl(source));
    const elapsed = performance.now() - started;

    assert.deepStrictEqual(codes(model), ["rsgl.unionWidened"]);
    assert.strictEqual(model.diagnostics[0].severity, "warning");
    assert.strictEqual(formatType(symbolType(model, "values")), "List<Number>");
    assert.ok(elapsed < 5_000, `Expected bounded inference, took ${elapsed.toFixed(1)}ms`);
  });

  it("widens oversized record unions to their common open shape", () => {
    let widened = false;
    const arms: RsglType[] = Array.from({ length: 4 }, (_, index) => ({
      kind: "Object",
      properties: new Map([
        ["kind", objectProperty({ kind: "String", literalValue: `kind_${index}` })],
        ["shared", objectProperty({ kind: "Number", literalValue: index })],
        [`unique_${index}`, objectProperty({ kind: "Boolean", literalValue: true })]
      ]),
      open: false
    }));
    const result = combineRsglTypes(arms, false, {
      maxArms: 2,
      onWiden: () => { widened = true; }
    });

    assert.strictEqual(widened, true);
    assert.strictEqual(result.kind, "Object");
    assert.strictEqual(result.open, true);
    assert.deepStrictEqual(Array.from(result.properties?.keys() ?? []), ["kind", "shared"]);
    assert.strictEqual(result.properties?.get("kind")?.type.kind, "String");
    assert.strictEqual(result.properties?.get("shared")?.type.kind, "Number");
  });
});

function bind(lines: string[]): RsglSemanticModel {
  return bindRsglModule(parseRsgl(lines.join("\n")));
}

function codes(model: RsglSemanticModel): string[] {
  return model.diagnostics.map(diagnostic => diagnostic.code);
}

function symbolType(model: RsglSemanticModel, name: string): RsglType {
  const symbol = model.symbols.find(candidate => candidate.name === name);
  assert.ok(symbol, `Expected semantic symbol '${name}'.`);
  return symbol.type;
}
