import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pngMetadataHeaderBytes, readPngFileMetadata, readPngMetadata } from "../../src";

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Builds the smallest byte layout that parses as a PNG header with the given dimensions. */
function createPngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from(pngSignature).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("PNG metadata", () => {
  it("reads the dimensions from a minimal IHDR header", () => {
    assert.deepStrictEqual(readPngMetadata(createPngBytes(16, 32)), { width: 16, height: 32 });
    assert.deepStrictEqual(readPngMetadata(createPngBytes(1, 1)), { width: 1, height: 1 });
  });

  it("reads dimensions from a view into a larger buffer", () => {
    const padded = Buffer.concat([Buffer.alloc(8, 0xab), createPngBytes(64, 48), Buffer.alloc(4, 0xcd)]);
    const view = padded.subarray(8, 8 + 24);
    assert.deepStrictEqual(readPngMetadata(view), { width: 64, height: 48 });
  });

  it("returns null for bytes without the PNG signature", () => {
    const bytes = createPngBytes(16, 16);
    bytes[0] = 0x00;
    assert.strictEqual(readPngMetadata(bytes), null);
    assert.strictEqual(readPngMetadata(Buffer.from("GIF89a definitely not a png", "ascii")), null);
  });

  it("returns null when the first chunk is not IHDR", () => {
    const bytes = createPngBytes(16, 16);
    bytes.write("IDAT", 12, "ascii");
    assert.strictEqual(readPngMetadata(bytes), null);
  });

  it("returns null for truncated and empty inputs", () => {
    assert.strictEqual(readPngMetadata(new Uint8Array(0)), null);
    assert.strictEqual(readPngMetadata(Buffer.from(pngSignature)), null);
    assert.strictEqual(readPngMetadata(createPngBytes(16, 16).subarray(0, 23)), null);
  });

  it("reads file metadata from the PNG header", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-assets-png-"));
    const fileName = path.join(root, "large.png");

    try {
      fs.writeFileSync(fileName, Buffer.concat([
        createPngBytes(32, 16),
        Buffer.alloc(1024 * 1024, 0xab)
      ]));

      assert.deepStrictEqual(readPngFileMetadata(fileName), { width: 32, height: 16 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps PNG file metadata reads bounded to the header", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "packages", "mc-assets", "src", "fileMetadata.ts"),
      "utf8"
    );

    assert.ok(source.includes("readFilePrefix(fileName, pngMetadataHeaderBytes)"));
    assert.ok(source.includes("fs.readSync(handle, bytes, 0, byteLength, 0)"));
    assert.strictEqual(pngMetadataHeaderBytes, 24);
    assert.strictEqual(source.includes("readPngMetadata(fs.readFileSync"), false);
  });
});
