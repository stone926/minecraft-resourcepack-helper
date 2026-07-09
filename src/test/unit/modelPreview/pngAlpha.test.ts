import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { readPngAlphaMask, type PngAlphaDecodeOptions } from "../../../modelPreview/service/PngAlphaDecoder";
import { createPngBytes, createRgbaPng } from "../helpers/tempPack";

describe("png alpha mask", () => {
  it("reads per-pixel opacity from RGBA PNG bytes", async () => {
    const mask = await readAlphaMask(createRgbaPng(2, 2, (x, y) => x === 0 && y === 0 ? 255 : 0));

    assert.ok(mask);
    assert.strictEqual(mask.width, 2);
    assert.strictEqual(mask.height, 2);
    assert.strictEqual(mask.isOpaque(0, 0), true);
    assert.strictEqual(mask.isOpaque(1, 0), false);
    assert.strictEqual(mask.isOpaque(0, 1), false);
    assert.strictEqual(mask.isOpaque(1, 1), false);
  });

  it("treats any positive alpha as opaque", async () => {
    const mask = await readAlphaMask(createRgbaPng(2, 1, x => x === 0 ? 1 : 0));

    assert.ok(mask);
    assert.strictEqual(mask.isOpaque(0, 0), true);
    assert.strictEqual(mask.isOpaque(1, 0), false);
  });

  it("returns null for malformed or truncated PNG bytes instead of throwing", async () => {
    assert.strictEqual(await readAlphaMask(Buffer.from("not png")), null);
    assert.strictEqual(await readAlphaMask(Buffer.alloc(0)), null);
    assert.strictEqual(await readAlphaMask(createPngBytes(16, 16)), null, "header-only PNG bytes have no complete chunks");
  });

  it("returns null for unsupported bit depths", async () => {
    const png = Buffer.from(createRgbaPng(2, 2, () => 255));
    png[24] = 16;

    assert.strictEqual(await readAlphaMask(png), null);
  });

  it("returns null before inflating PNGs that exceed decode limits", async () => {
    let inflated = false;
    const mask = await readPngAlphaMask(
      createRgbaPng(2, 2, () => 255),
      async () => {
        inflated = true;
        return Buffer.alloc(0);
      },
      { maxInflatedBytes: 1 }
    );

    assert.strictEqual(mask, null);
    assert.strictEqual(inflated, false);
  });

  it("keeps zlib behind async service-layer inflater injection", () => {
    const generatedItemModel = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "bake", "GeneratedItemModel.ts"), "utf8");
    const decoder = fs.readFileSync(path.join(process.cwd(), "src", "modelPreview", "service", "PngAlphaDecoder.ts"), "utf8");

    assert.strictEqual(generatedItemModel.includes("readPngAlphaMask"), false, "generated item bake should consume an alpha reader interface");
    assert.strictEqual(decoder.includes("node:zlib"), false, "PNG decoder should not own the Node zlib dependency");
    assert.strictEqual(decoder.includes("inflateSync"), false, "PNG decoding should not use synchronous inflate");
  });
});

const inflate = promisify(zlib.inflate);

function readAlphaMask(bytes: Uint8Array, options?: PngAlphaDecodeOptions) {
  return readPngAlphaMask(
    bytes,
    idat => inflate(Buffer.from(idat.buffer, idat.byteOffset, idat.byteLength)),
    options
  );
}
