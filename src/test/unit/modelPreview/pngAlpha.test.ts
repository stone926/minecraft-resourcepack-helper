import * as assert from "node:assert";
import { readPngAlphaMask } from "../../../modelPreview/bake/PngAlpha";
import { createPngBytes, createRgbaPng } from "../helpers/tempPack";

describe("png alpha mask", () => {
  it("reads per-pixel opacity from RGBA PNG bytes", () => {
    const mask = readPngAlphaMask(createRgbaPng(2, 2, (x, y) => x === 0 && y === 0 ? 255 : 0));

    assert.ok(mask);
    assert.strictEqual(mask.width, 2);
    assert.strictEqual(mask.height, 2);
    assert.strictEqual(mask.isOpaque(0, 0), true);
    assert.strictEqual(mask.isOpaque(1, 0), false);
    assert.strictEqual(mask.isOpaque(0, 1), false);
    assert.strictEqual(mask.isOpaque(1, 1), false);
  });

  it("treats any positive alpha as opaque", () => {
    const mask = readPngAlphaMask(createRgbaPng(2, 1, x => x === 0 ? 1 : 0));

    assert.ok(mask);
    assert.strictEqual(mask.isOpaque(0, 0), true);
    assert.strictEqual(mask.isOpaque(1, 0), false);
  });

  it("returns null for malformed or truncated PNG bytes instead of throwing", () => {
    assert.strictEqual(readPngAlphaMask(Buffer.from("not png")), null);
    assert.strictEqual(readPngAlphaMask(Buffer.alloc(0)), null);
    assert.strictEqual(readPngAlphaMask(createPngBytes(16, 16)), null, "header-only PNG bytes have no complete chunks");
  });

  it("returns null for unsupported bit depths", () => {
    const png = Buffer.from(createRgbaPng(2, 2, () => 255));
    png[24] = 16;

    assert.strictEqual(readPngAlphaMask(png), null);
  });
});
