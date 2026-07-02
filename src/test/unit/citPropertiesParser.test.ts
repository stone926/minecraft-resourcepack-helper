import * as assert from "node:assert";
import { parseCitProperties } from "../../utils/citPropertiesParser";

describe("CIT properties parser", () => {
  it("returns key, value, and ranges for property entries", () => {
    const entries = parseCitProperties([
      "# comment",
      "  texture.layer0 = ./textures/sword  ",
      "",
      "type=item"
    ].join("\n"));

    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0], {
      key: "texture.layer0",
      value: "./textures/sword",
      rawKey: "texture.layer0",
      rawValue: "./textures/sword",
      keyRange: { start: { line: 2, column: 2 }, end: { line: 2, column: 16 } },
      valueRange: { start: { line: 2, column: 19 }, end: { line: 2, column: 35 } },
      fullRange: { start: { line: 2, column: 2 }, end: { line: 2, column: 35 } },
      line: 2
    });
    assert.strictEqual(entries[1].key, "type");
    assert.strictEqual(entries[1].value, "item");
  });

  it("supports escaped separators in keys and values", () => {
    const entries = parseCitProperties("nbt.display.Name\\=json=regex:foo\\=bar");

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].key, "nbt.display.Name=json");
    assert.strictEqual(entries[0].value, "regex:foo=bar");
  });
});
