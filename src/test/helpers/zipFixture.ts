import { deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  path: string;
  content?: string | Uint8Array;
  compression?: "stored" | "deflate";
}

interface EncodedFixtureEntry {
  name: Buffer;
  content: Buffer;
  compressed: Buffer;
  compressionMethod: number;
  crc32: number;
  localOffset: number;
}

/** Minimal standards-compliant ZIP writer used only by archive-reader tests. */
export function createZipFixture(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const encoded: EncodedFixtureEntry[] = [];
  const localParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = typeof entry.content === "string"
      ? Buffer.from(entry.content, "utf8")
      : Buffer.from(entry.content ?? new Uint8Array());
    const compressionMethod = entry.compression === "stored" ? 0 : 8;
    const compressed = compressionMethod === 0 ? content : deflateRawSync(content);
    const fixture: EncodedFixtureEntry = {
      name,
      content,
      compressed,
      compressionMethod,
      crc32: crc32(content),
      localOffset
    };
    encoded.push(fixture);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(compressionMethod, 8);
    header.writeUInt32LE(fixture.crc32, 14);
    header.writeUInt32LE(compressed.byteLength, 18);
    header.writeUInt32LE(content.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    localParts.push(header, name, compressed);
    localOffset += header.byteLength + name.byteLength + compressed.byteLength;
  }

  const centralParts = encoded.flatMap(entry => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.compressionMethod, 10);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.compressed.byteLength, 20);
    header.writeUInt32LE(entry.content.byteLength, 24);
    header.writeUInt16LE(entry.name.byteLength, 28);
    header.writeUInt32LE(entry.localOffset, 42);
    return [header, entry.name];
  });
  const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(encoded.length, 8);
  end.writeUInt16LE(encoded.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, end]));
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const table = crcTable ??= createCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
