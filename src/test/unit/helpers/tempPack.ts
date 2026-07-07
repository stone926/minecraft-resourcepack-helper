import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

export function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-"));
}

export function removeTempDirectory(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function createPack(root: string, name: string): string {
  const pack = path.join(root, name);
  writeJson(pack, "pack.mcmeta", {
    pack: {
      ["min_format"]: [88, 0],
      ["max_format"]: [88, 0],
      description: "test"
    }
  });
  return pack;
}

export function writeJson(root: string, relativePath: string, value: unknown): void {
  writeFile(root, relativePath, JSON.stringify(value, null, 2));
}

export function writeFile(root: string, relativePath: string, value: string | Uint8Array): void {
  const fileName = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, value);
}

export function createPngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

export function createRgbaPng(width: number, height: number, alphaAt: (x: number, y: number) => number): Buffer {
  const rowStride = width * 4 + 1;
  const rows = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    rows[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const offset = rowOffset + 1 + x * 4;
      rows[offset] = 255;
      rows[offset + 1] = 255;
      rows[offset + 2] = 255;
      rows[offset + 3] = alphaAt(x, y);
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      8,
      6,
      0,
      0,
      0
    ])),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export function createOggVorbisBytes(channels: number, sampleRate: number, samples: number): Buffer {
  const identification = Buffer.alloc(30);
  identification[0] = 1;
  identification.write("vorbis", 1, "ascii");
  identification.writeUInt32LE(0, 7);
  identification[11] = channels;
  identification.writeUInt32LE(sampleRate, 12);
  identification[29] = 1;
  return Buffer.concat([
    createOggPage(identification, 0n, 0, 2),
    createOggPage(Buffer.from([0]), BigInt(samples), 1, 4)
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function createOggPage(packet: Buffer, granule: bigint, sequence: number, headerType: number): Buffer {
  const segments = [packet.length];
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header[5] = headerType;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  header[27] = packet.length;
  return Buffer.concat([header, packet]);
}
