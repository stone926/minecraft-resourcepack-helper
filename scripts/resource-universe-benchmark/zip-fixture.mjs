/**
 * Small in-memory ZIP writer for exercising the production extraction-free
 * reader. Stored entries isolate central-directory indexing and targeted-read
 * overhead from fixture compression time.
 */
export function createStoredZipFixture(entryCount) {
  if (!Number.isInteger(entryCount) || entryCount <= 0 || entryCount > 65_535) {
    throw new Error("Classic ZIP benchmark entry count must be between 1 and 65,535.");
  }

  const localParts = [];
  const centralParts = [];
  const entryPaths = [];
  let localOffset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entryPath = benchmarkEntryPath(index);
    const name = Buffer.from(entryPath, "utf8");
    const content = Buffer.from(`{"index":${index},"kind":"model"}\n`, "utf8");
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    entryPaths.push(entryPath);
    localOffset += localHeader.byteLength + name.byteLength + content.byteLength;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Object.freeze({
    bytes: new Uint8Array(Buffer.concat([...localParts, ...centralParts, end])),
    entryPaths: Object.freeze(entryPaths)
  });
}

function benchmarkEntryPath(index) {
  const suffix = String(index).padStart(6, "0");
  return index === 0
    ? "assets/bench/models/block/路径 空格-000000.json"
    : `assets/bench/models/block/model-${suffix}.json`;
}

let crcTable;

function crc32(bytes) {
  const table = crcTable ??= createCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
