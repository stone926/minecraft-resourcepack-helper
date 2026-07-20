import * as assert from "node:assert";

export interface DeterministicZipEntry {
  name: string;
  content: string | Buffer;
}

interface NormalizedZipEntry {
  name: string;
  nameBytes: Buffer;
  content: Buffer;
  crc32: number;
  localHeaderOffset: number;
}

const utf8Flag = 0x0800;
const storedCompressionMethod = 0;
const dosEpochDate = 0x0021;

/**
 * Creates a byte-for-byte reproducible ZIP archive using the uncompressed
 * storage method and the DOS epoch timestamp. This keeps archive fixtures
 * independent from platform ZIP tools and ambient filesystem mtimes.
 */
export function createDeterministicStoredZip(entries: readonly DeterministicZipEntry[]): Buffer {
  const normalized = normalizeEntries(entries);
  const localParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of normalized) {
    entry.localHeaderOffset = localOffset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(utf8Flag, 6);
    header.writeUInt16LE(storedCompressionMethod, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosEpochDate, 12);
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(entry.content.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(entry.nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, entry.nameBytes, entry.content);
    localOffset += header.length + entry.nameBytes.length + entry.content.length;
  }

  const centralParts: Buffer[] = [];
  let centralSize = 0;
  for (const entry of normalized) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(utf8Flag, 8);
    header.writeUInt16LE(storedCompressionMethod, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(dosEpochDate, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.content.length, 20);
    header.writeUInt32LE(entry.content.length, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.localHeaderOffset, 42);
    centralParts.push(header, entry.nameBytes);
    centralSize += header.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

/** Reads the stored entries emitted by createDeterministicStoredZip. */
export function readDeterministicStoredZip(archive: Buffer): ReadonlyMap<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    assert.strictEqual(archive.readUInt16LE(offset + 8), storedCompressionMethod);
    const expectedCrc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    assert.strictEqual(compressedSize, uncompressedSize);

    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const contentEnd = contentStart + uncompressedSize;
    assert.ok(contentEnd <= archive.length, "ZIP entry extends beyond the archive boundary");
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const content = Buffer.from(archive.subarray(contentStart, contentEnd));
    assert.strictEqual(crc32(content), expectedCrc, `CRC mismatch for ${name}`);
    assert.strictEqual(entries.has(name), false, `Duplicate ZIP entry ${name}`);
    entries.set(name, content);
    offset = contentEnd;
  }
  assert.strictEqual(archive.readUInt32LE(offset), 0x02014b50, "Missing ZIP central directory");
  return entries;
}

function normalizeEntries(entries: readonly DeterministicZipEntry[]): NormalizedZipEntry[] {
  const names = new Set<string>();
  return entries.map(entry => {
    const name = entry.name.replaceAll("\\", "/");
    assert.ok(name.length > 0 && !name.startsWith("/"), `Unsafe ZIP entry ${entry.name}`);
    assert.ok(!name.split("/").some(segment => segment === "" || segment === "." || segment === ".."),
      `Unsafe ZIP entry ${entry.name}`);
    assert.strictEqual(names.has(name), false, `Duplicate ZIP entry ${name}`);
    names.add(name);
    const content = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    return {
      name,
      nameBytes: Buffer.from(name, "utf8"),
      content,
      crc32: crc32(content),
      localHeaderOffset: 0
    };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

const crcTable = createCrcTable();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
