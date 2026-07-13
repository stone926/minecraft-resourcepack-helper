import * as assert from "node:assert";
import { performance } from "node:perf_hooks";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
import { inferProductType } from "../../src/semantic/productTypeInference";
import { objectProperty, RsglType } from "../../src/semantic/types";

describe("RSGL product structural inference", () => {
  it("binds each product field to its source element type", () => {
    const model = bindRsglModule(parseRsgl([
      "type Row = { name: String }",
      "let rows: List<Row> = [{ name: \"north\" }]",
      "for combo in product({ row: rows, column: [1, 2] }) {",
      "  let rowName: String = combo.row.name",
      "  let column: Number = combo.column",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(
      model.symbols.find(symbol => symbol.name === "rowName")?.type.kind,
      "String"
    );
    assert.strictEqual(
      model.symbols.find(symbol => symbol.name === "column")?.type.kind,
      "Number"
    );
  });

  it("reports misspelled product fields and non-iterable dimensions", () => {
    const model = bindRsglModule(parseRsgl([
      "for combo in product({ wood: [\"oak\"], invalid: 1 }) {",
      "  let typo = combo.woood",
      "}"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.unknownRecordField"));
    assert.ok(codes.includes("rsgl.productSourceNotIterable"));
  });

  it("preserves property order, literal unions, and optional metadata", () => {
    const model = bindRsglModule(parseRsgl([
      "type Dimensions = { row: List<\"north\"> | Range, column?: List<1> }",
      "let dimensions: Dimensions = { row: [\"north\"], column: [1] }",
      "for combination in product(dimensions) { }"
    ].join("\n")));
    const combination = model.symbols.find(symbol => symbol.name === "combination")?.type;

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(combination?.kind, "Object");
    assert.deepStrictEqual(Array.from(combination?.properties?.keys() ?? []), ["row", "column"]);
    assert.strictEqual(combination?.properties?.get("column")?.optional, true);
    assert.strictEqual(combination?.properties?.get("column")?.type.literalValue, 1);
    assert.deepStrictEqual(
      combination?.properties?.get("row")?.type.options?.map(option => option.kind).sort(),
      ["Number", "String"]
    );
    assert.ok(combination?.properties?.get("row")?.type.options?.some(option => option.literalValue === "north"));
  });

  it("distributes product inference across source record unions", () => {
    const model = bindRsglModule(parseRsgl([
      "type DimensionVariant = { value: List<\"oak\"> } | { value: Range }",
      "let chooseList = true",
      "let listDimensions: { value: List<\"oak\"> } = { value: [\"oak\"] }",
      "let rangeDimensions: { value: Range } = { value: 0..2 }",
      "let dimensions: DimensionVariant = chooseList ? listDimensions : rangeDimensions",
      "for variantRow in product(dimensions) {",
      "  let variantValue = variantRow.value",
      "}"
    ].join("\n")));
    const variantRow = model.symbols.find(symbol => symbol.name === "variantRow")?.type;
    const variantValue = model.symbols.find(symbol => symbol.name === "variantValue")?.type;

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(variantRow?.kind, "Union");
    assert.ok(variantRow?.options?.every(option => option.kind === "Object"));
    assert.strictEqual(variantValue?.kind, "Union");
    assert.deepStrictEqual(variantValue?.options?.map(option => option.kind).sort(), ["Number", "String"]);
  });

  it("keeps empty products closed for typo diagnostics", () => {
    const model = bindRsglModule(parseRsgl([
      "for emptyRow in product({}) {",
      "  let typo = emptyRow.unexpected",
      "}"
    ].join("\n")));
    const emptyRow = model.symbols.find(symbol => symbol.name === "emptyRow")?.type;

    assert.strictEqual(emptyRow?.kind, "Object");
    assert.strictEqual(emptyRow?.open, false);
    assert.strictEqual(emptyRow?.properties?.size, 0);
    assert.deepStrictEqual(
      model.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.unknownRecordField"]
    );
  });

  it("retains open and Json product rows without inventing a closed shape", () => {
    const model = bindRsglModule(parseRsgl([
      "let key = \"row\"",
      "let dynamicDimensions = { [key]: [1, 2] }",
      "for dynamicRow in product(dynamicDimensions) {",
      "  let dynamicValue: Number = dynamicRow.anyField",
      "}",
      "let jsonDimensions: Json = dynamicDimensions",
      "for jsonRow in product(jsonDimensions) {",
      "  let jsonValue: Json = jsonRow.anyField",
      "}"
    ].join("\n")));
    const dynamicRow = model.symbols.find(symbol => symbol.name === "dynamicRow")?.type;
    const jsonRow = model.symbols.find(symbol => symbol.name === "jsonRow")?.type;

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(dynamicRow?.kind, "Object");
    assert.strictEqual(dynamicRow?.open, true);
    assert.notStrictEqual(dynamicRow?.indexType?.kind, "List");
    assert.strictEqual(jsonRow?.kind, "Object");
    assert.strictEqual(jsonRow?.open, true);
    assert.strictEqual(jsonRow?.indexType?.kind, "Json");
  });

  it("checks every invalid dimension while preserving unified argument binding", () => {
    const model = bindRsglModule(parseRsgl([
      "let rows = product(source: { first: 1, second: false })",
      "let duplicate = product({ valid: [missingValue] }, source: { ignored: [1] })"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.productSourceNotIterable").length, 2);
    assert.strictEqual(codes.filter(code => code === "rsgl.duplicateArgument").length, 1);
    assert.strictEqual(codes.filter(code => code === "rsgl.undefinedSymbol").length, 1);
  });

  it("infers large product records in linear time", () => {
    const fieldCount = 5000;
    const properties = new Map<string, ReturnType<typeof objectProperty>>();
    for (let index = 0; index < fieldCount; index++) {
      properties.set(`field${index}`, objectProperty({
        kind: "List",
        elementType: { kind: "Number", literalValue: index }
      }));
    }
    const sourceType: RsglType = { kind: "Object", properties, open: false };

    const startedAt = performance.now();
    const result = inferProductType(sourceType);
    const elapsed = performance.now() - startedAt;
    const row = result.type.elementType;

    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(row?.kind, "Object");
    assert.strictEqual(row?.properties?.size, fieldCount);
    assert.deepStrictEqual(Array.from(row?.properties?.keys() ?? []).slice(-2), ["field4998", "field4999"]);
    assert.strictEqual(row?.properties?.get("field4999")?.type.literalValue, 4999);
    assert.ok(elapsed < 5000, `Expected linear product inference under 5s, got ${elapsed.toFixed(1)}ms.`);
  });
});
