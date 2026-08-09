import * as assert from "node:assert/strict";
import {
  combineRsglTypes,
  formatType,
  inferListType,
  isAssignable,
  neverType,
  normalizeRsglType,
  objectProperty,
  type RsglType
} from "../../src/semantic";

describe("RSGL structural type relations", () => {
  it("uses Never as an internal bottom type for empty lists", () => {
    const empty = inferListType([]);

    assert.strictEqual(empty.kind, "List");
    assert.strictEqual(empty.elementType?.kind, "Never");
    assert.strictEqual(isAssignable({ kind: "String" }, neverType), true);
    assert.strictEqual(isAssignable(neverType, { kind: "String" }), false);
    assert.strictEqual(isAssignable(
      { kind: "List", elementType: { kind: "String" } },
      empty
    ), true);
    assert.strictEqual(
      formatType(combineRsglTypes([neverType, { kind: "String" }])),
      "String"
    );
    assert.strictEqual(combineRsglTypes([]).kind, "Unknown");
  });

  it("keeps builtin type parameters distinct in structural identities", () => {
    const first: RsglType = { kind: "TypeParameter", typeParameterName: "T" };
    const second: RsglType = { kind: "TypeParameter", typeParameterName: "U" };

    assert.strictEqual(formatType(first), "T");
    assert.strictEqual(isAssignable(first, first), true);
    assert.strictEqual(isAssignable(first, second), false);
    assert.strictEqual(formatType(combineRsglTypes([first, second])), "T | U");
  });

  it("flattens, deduplicates, and deterministically orders unions", () => {
    const first = combineRsglTypes([
      { kind: "String" },
      { kind: "Union", options: [{ kind: "Boolean" }, { kind: "Number" }] },
      { kind: "String" }
    ]);
    const second = combineRsglTypes([
      { kind: "Number" },
      { kind: "String" },
      { kind: "Boolean" }
    ]);

    assert.strictEqual(formatType(first), "Boolean | Number | String");
    assert.strictEqual(formatType(second), formatType(first));
    assert.deepStrictEqual(normalizeRsglType(first), normalizeRsglType(second));
  });

  it("compares nested list, object, and union types recursively", () => {
    const expected: RsglType = objectType({
      items: {
        kind: "List",
        elementType: objectType({ id: { kind: "String" } })
      }
    });
    const compatible: RsglType = objectType({
      items: {
        kind: "List",
        elementType: objectType({ id: { kind: "String" }, weight: { kind: "Number" } })
      },
      label: { kind: "String" }
    });
    const incompatible: RsglType = objectType({
      items: {
        kind: "List",
        elementType: objectType({ id: { kind: "Number" } })
      }
    });

    assert.strictEqual(isAssignable(expected, compatible), true);
    assert.strictEqual(isAssignable(expected, incompatible), false);
    assert.strictEqual(isAssignable(
      expected,
      { kind: "Union", options: [compatible, incompatible] }
    ), false);
    assert.strictEqual(isAssignable(
      { kind: "Union", options: [expected, { kind: "Number" }] },
      compatible
    ), true);
  });

  it("checks recursive object index signatures", () => {
    const expected: RsglType = {
      kind: "Object",
      properties: new Map(),
      indexType: { kind: "List", elementType: { kind: "Number" } }
    };
    const compatible = objectType({
      first: { kind: "List", elementType: { kind: "Number" } },
      second: { kind: "List", elementType: { kind: "Number" } }
    });
    const incompatible = objectType({
      first: { kind: "List", elementType: { kind: "String" } }
    });

    assert.strictEqual(isAssignable(expected, compatible), true);
    assert.strictEqual(isAssignable(expected, incompatible), false);
  });
});

function objectType(properties: Record<string, RsglType>): RsglType {
  return {
    kind: "Object",
    properties: new Map(
      Object.entries(properties).map(([name, type]) => [name, objectProperty(type)])
    )
  };
}
