import * as assert from "node:assert";
import { TextOffsetMap } from "../../utils/textOffsets";

describe("text offset mapping", () => {
  const text = "first\r\nsecond\nthird";
  const offsets = new TextOffsetMap(text);

  it("maps zero-based positions to UTF-16 offsets", () => {
    assert.strictEqual(offsets.offsetAt({ line: 0, character: 0 }), 0);
    assert.strictEqual(offsets.offsetAt({ line: 1, character: 3 }), 10);
    assert.strictEqual(offsets.offsetAt({ line: 2, character: 5 }), text.length);
  });

  it("rejects positions outside the document", () => {
    assert.strictEqual(offsets.offsetAt({ line: -1, character: 0 }), null);
    assert.strictEqual(offsets.offsetAt({ line: 3, character: 0 }), null);
    assert.strictEqual(offsets.offsetAt({ line: 1, character: 8 }), null);
  });

  it("maps and clamps offsets to zero-based positions", () => {
    assert.deepStrictEqual(offsets.positionAt(10), { line: 1, character: 3 });
    assert.deepStrictEqual(offsets.positionAt(-20), { line: 0, character: 0 });
    assert.deepStrictEqual(offsets.positionAt(text.length + 20), { line: 2, character: 5 });
  });
});
