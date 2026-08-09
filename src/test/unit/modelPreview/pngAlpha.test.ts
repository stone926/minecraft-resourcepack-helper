import * as assert from "node:assert/strict";
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

  it("decodes every standard scanline filter", async () => {
    for (let filter = 0; filter <= 4; filter++) {
      const mask = await readAlphaMask(createFilteredRgbaPng(filter));

      assert.ok(mask, `filter ${filter} should decode`);
      assert.strictEqual(mask.isOpaque(0, 0), true);
      assert.strictEqual(mask.isOpaque(1, 0), false);
      assert.strictEqual(mask.isOpaque(0, 1), false);
      assert.strictEqual(mask.isOpaque(1, 1), true);
    }
  });

  it("decodes packed palette alpha", async () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 1;
    header[9] = 3;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])),
      pngChunk("tRNS", Buffer.from([0, 255])),
      pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0b0100_0000]))),
      pngChunk("IEND", Buffer.alloc(0))
    ]);

    const mask = await readAlphaMask(png);
    assert.ok(mask);
    assert.strictEqual(mask.isOpaque(0, 0), false);
    assert.strictEqual(mask.isOpaque(1, 0), true);
  });

  it("returns null for malformed or truncated PNG bytes instead of throwing", async () => {
    assert.strictEqual(await readAlphaMask(Buffer.from("not png")), null);
    assert.strictEqual(await readAlphaMask(Buffer.alloc(0)), null);
    assert.strictEqual(await readAlphaMask(createPngBytes(16, 16)), null, "header-only PNG bytes have no complete chunks");

    const shortHeader = Buffer.alloc(21);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(shortHeader);
    shortHeader.writeUInt32BE(1, 8);
    shortHeader.write("IHDR", 12, "ascii");
    assert.strictEqual(await readAlphaMask(shortHeader), null, "short IHDR chunks must not escape as range errors");
  });

  it("rejects invalid scanline filters", async () => {
    const png = createRgbaPng(1, 1, () => 255);
    const idatLength = png.readUInt32BE(33);
    const inflated = zlib.inflateSync(png.subarray(41, 41 + idatLength));
    inflated[0] = 5;
    const invalidIdat = zlib.deflateSync(inflated);
    const invalidPng = Buffer.concat([
      png.subarray(0, 33),
      pngChunk("IDAT", invalidIdat),
      pngChunk("IEND", Buffer.alloc(0))
    ]);

    assert.strictEqual(await readAlphaMask(invalidPng), null);
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

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function createFilteredRgbaPng(filter: number): Buffer {
  const width = 2;
  const height = 2;
  const rowBytes = width * 4;
  const rows = Buffer.alloc(height * (rowBytes + 1));
  let previous = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const current = Buffer.alloc(rowBytes);
    for (let x = 0; x < width; x++) {
      const offset = x * 4;
      current.fill(255, offset, offset + 3);
      current[offset + 3] = x === y ? 255 : 0;
    }

    const rowOffset = y * (rowBytes + 1);
    rows[rowOffset] = filter;
    for (let index = 0; index < rowBytes; index++) {
      const left = index >= 4 ? current[index - 4] : 0;
      const up = previous[index];
      const upLeft = index >= 4 ? previous[index - 4] : 0;
      rows[rowOffset + 1 + index] = (current[index] - filterPredictor(filter, left, up, upLeft)) & 0xff;
    }
    previous = current;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function filterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) {
    return left;
  }
  if (filter === 2) {
    return up;
  }
  if (filter === 3) {
    return Math.floor((left + up) / 2);
  }
  if (filter !== 4) {
    return 0;
  }

  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}
