import * as assert from "node:assert";
import { parseCitProperties, parseCitPropertiesDocument } from "../../cit/citPropertiesParser";
import { formatDefaultMessage } from "./helpers/localizedMessages";

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

  it("keeps namespaced keys when equals is used as the separator", () => {
    const entries = parseCitProperties("citresewn:useGlint=true");

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].key, "citresewn:useGlint");
    assert.strictEqual(entries[0].value, "true");
  });

  it("supports colon separators when equals is absent", () => {
    const entries = parseCitProperties("texture: ./textures/sword");

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].key, "texture");
    assert.strictEqual(entries[0].value, "./textures/sword");
  });

  it("supports multiline continuations and unicode escapes", () => {
    const entries = parseCitProperties([
      "nbt.display.Name=regex:foo\\",
      "  \\u0041bar"
    ].join("\n"));

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].rawValue, "regex:foo\\n\\u0041bar");
    assert.strictEqual(entries[0].value, "regex:foo\nAbar");
    assert.deepStrictEqual(entries[0].valueRange.end, { line: 2, column: 11 });
  });

  it("reports missing separators and invalid unicode escapes", () => {
    const result = parseCitPropertiesDocument([
      "items minecraft_stick",
      "nbt.display.Name=\\u12G4"
    ].join("\n"));

    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.errors.length, 2);
    assert.ok(result.errors.some(error => formatDefaultMessage(error.message).includes("Missing CIT property separator")));
    assert.ok(result.errors.some(error => formatDefaultMessage(error.message).includes("Invalid unicode escape")));
  });

  it("reports malformed keys even when equals or colon separators are present", () => {
    const result = parseCitPropertiesDocument([
      "bad key=minecraft:stick",
      "=minecraft:stick",
      "items minecraft:stick"
    ].join("\n"));

    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.entries.every(entry => entry.hasSyntaxError), true);
    assert.ok(result.errors.some(error => formatDefaultMessage(error.message).includes("cannot contain whitespace")));
    assert.ok(result.errors.some(error => formatDefaultMessage(error.message).includes("cannot be empty")));
  });
});
