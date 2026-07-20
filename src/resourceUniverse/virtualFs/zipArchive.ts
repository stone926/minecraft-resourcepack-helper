import { inflateRawSync } from "node:zlib";

const endOfCentralDirectorySignature = 0x06054b50;
const zip64EndOfCentralDirectorySignature = 0x06064b50;
const zip64EndOfCentralDirectoryLocatorSignature = 0x07064b50;
const centralDirectoryHeaderSignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
const zip64ExtraFieldId = 0x0001;
const utf8FileNameFlag = 0x0800;
const encryptedEntryFlag = 0x0001;
const maximumEndRecordSearch = 65_535 + 22;

export type ZipArchiveEntryType = "file" | "directory";

export interface ZipArchiveEntryStat {
  type: ZipArchiveEntryType;
  size: number;
  mtime: number;
}

export interface ZipArchiveDirectoryEntry {
  name: string;
  type: ZipArchiveEntryType;
}

export interface ZipArchiveOptions {
  /** Bounds central-directory work for malformed or hostile archives. */
  maximumEntries?: number;
  /** Bounds inflation of a single entry while still permitting large media assets. */
  maximumEntryBytes?: number;
}

export type ZipArchiveErrorCode =
  | "invalidArchive"
  | "entryNotFound"
  | "notDirectory"
  | "isDirectory"
  | "unsupportedCompression"
  | "entryTooLarge";

export class ZipArchiveError extends Error {
  public constructor(
    public readonly code: ZipArchiveErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ZipArchiveError";
  }
}

interface ZipFileRecord {
  type: "file";
  path: string;
  compressionMethod: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  mtime: number;
}

interface ZipDirectoryRecord {
  type: "directory";
  path: string;
  children: Map<string, ZipArchiveEntryType>;
  mtime: number;
}

type ZipRecord = ZipFileRecord | ZipDirectoryRecord;

interface CentralDirectoryLocation {
  entryCount: number;
  offset: number;
  size: number;
}

interface Zip64ResolvedFields {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Immutable, extraction-free ZIP index. Only central-directory metadata and
 * the original compressed bytes are retained; entries are inflated on demand.
 */
export class ZipArchive {
  private readonly records = new Map<string, ZipRecord>();
  private readonly maximumEntryBytes: number;

  private constructor(
    private readonly bytes: Buffer,
    options: ZipArchiveOptions
  ) {
    this.maximumEntryBytes = options.maximumEntryBytes ?? 256 * 1024 * 1024;
    this.records.set("", {
      type: "directory",
      path: "",
      children: new Map(),
      mtime: 0
    });
    this.indexCentralDirectory(options.maximumEntries ?? 250_000);
  }

  public static fromBytes(bytes: Uint8Array, options: ZipArchiveOptions = {}): ZipArchive {
    return new ZipArchive(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      options
    );
  }

  public stat(pathValue: string): ZipArchiveEntryStat {
    const path = normalizeLookupPath(pathValue);
    const record = this.records.get(path);
    if (!record) {
      throw new ZipArchiveError("entryNotFound", `ZIP entry not found: ${pathValue}`);
    }
    return {
      type: record.type,
      size: record.type === "file" ? record.uncompressedSize : 0,
      mtime: record.mtime
    };
  }

  public readDirectory(pathValue: string): readonly ZipArchiveDirectoryEntry[] {
    const path = normalizeLookupPath(pathValue);
    const record = this.records.get(path);
    if (!record) {
      throw new ZipArchiveError("entryNotFound", `ZIP directory not found: ${pathValue}`);
    }
    if (record.type !== "directory") {
      throw new ZipArchiveError("notDirectory", `ZIP entry is not a directory: ${pathValue}`);
    }
    return [...record.children]
      .map(([name, type]) => ({ name, type }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  public readFile(pathValue: string): Uint8Array {
    const path = normalizeLookupPath(pathValue);
    const record = this.records.get(path);
    if (!record) {
      throw new ZipArchiveError("entryNotFound", `ZIP file not found: ${pathValue}`);
    }
    if (record.type !== "file") {
      throw new ZipArchiveError("isDirectory", `ZIP entry is a directory: ${pathValue}`);
    }
    if (record.uncompressedSize > this.maximumEntryBytes) {
      throw new ZipArchiveError(
        "entryTooLarge",
        `ZIP entry exceeds the ${this.maximumEntryBytes} byte read limit: ${pathValue}`
      );
    }
    if ((record.flags & encryptedEntryFlag) !== 0) {
      throw new ZipArchiveError("invalidArchive", `Encrypted ZIP entries are unsupported: ${pathValue}`);
    }

    const compressed = this.compressedEntryBytes(record);
    let result: Buffer;
    if (record.compressionMethod === 0) {
      result = Buffer.from(compressed);
    } else if (record.compressionMethod === 8) {
      try {
        result = inflateRawSync(compressed, { maxOutputLength: this.maximumEntryBytes });
      } catch (error) {
        throw new ZipArchiveError(
          "invalidArchive",
          `Unable to inflate ZIP entry '${pathValue}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      throw new ZipArchiveError(
        "unsupportedCompression",
        `ZIP entry '${pathValue}' uses unsupported compression method ${record.compressionMethod}.`
      );
    }

    if (result.byteLength !== record.uncompressedSize) {
      throw new ZipArchiveError(
        "invalidArchive",
        `ZIP entry '${pathValue}' has an invalid uncompressed size.`
      );
    }
    if (crc32(result) !== record.crc32) {
      throw new ZipArchiveError("invalidArchive", `ZIP entry '${pathValue}' failed its CRC-32 check.`);
    }
    return new Uint8Array(result);
  }

  private indexCentralDirectory(maximumEntries: number): void {
    const centralDirectory = locateCentralDirectory(this.bytes);
    if (centralDirectory.entryCount > maximumEntries) {
      throw new ZipArchiveError(
        "invalidArchive",
        `ZIP archive contains ${centralDirectory.entryCount} entries; limit is ${maximumEntries}.`
      );
    }
    const centralEnd = checkedAdd(
      centralDirectory.offset,
      centralDirectory.size,
      this.bytes.byteLength,
      "central directory"
    );
    let offset = centralDirectory.offset;
    for (let index = 0; index < centralDirectory.entryCount; index++) {
      assertAvailable(this.bytes, offset, 46, "central directory entry");
      if (this.bytes.readUInt32LE(offset) !== centralDirectoryHeaderSignature) {
        throw new ZipArchiveError("invalidArchive", `Invalid central directory entry at offset ${offset}.`);
      }
      const flags = this.bytes.readUInt16LE(offset + 8);
      const compressionMethod = this.bytes.readUInt16LE(offset + 10);
      const dosTime = this.bytes.readUInt16LE(offset + 12);
      const dosDate = this.bytes.readUInt16LE(offset + 14);
      const storedCrc32 = this.bytes.readUInt32LE(offset + 16);
      const compressedSize32 = this.bytes.readUInt32LE(offset + 20);
      const uncompressedSize32 = this.bytes.readUInt32LE(offset + 24);
      const fileNameLength = this.bytes.readUInt16LE(offset + 28);
      const extraLength = this.bytes.readUInt16LE(offset + 30);
      const commentLength = this.bytes.readUInt16LE(offset + 32);
      const localHeaderOffset32 = this.bytes.readUInt32LE(offset + 42);
      const variableSize = fileNameLength + extraLength + commentLength;
      assertAvailable(this.bytes, offset + 46, variableSize, "central directory entry payload");
      const fileNameBytes = this.bytes.subarray(offset + 46, offset + 46 + fileNameLength);
      const extra = this.bytes.subarray(
        offset + 46 + fileNameLength,
        offset + 46 + fileNameLength + extraLength
      );
      const resolved = resolveZip64Fields(
        extra,
        compressedSize32,
        uncompressedSize32,
        localHeaderOffset32
      );
      const decodedName = decodeFileName(fileNameBytes, (flags & utf8FileNameFlag) !== 0);
      const normalized = normalizeArchiveEntryPath(decodedName);
      if (normalized.path) {
        const mtime = dosDateTime(dosDate, dosTime);
        this.addRecord(normalized.directory ? {
          type: "directory",
          path: normalized.path,
          children: new Map<string, ZipArchiveEntryType>(),
          mtime
        } : {
          type: "file",
          path: normalized.path,
          compressionMethod,
          flags,
          crc32: storedCrc32,
          compressedSize: resolved.compressedSize,
          uncompressedSize: resolved.uncompressedSize,
          localHeaderOffset: resolved.localHeaderOffset,
          mtime
        });
      }
      offset += 46 + variableSize;
      if (offset > centralEnd) {
        throw new ZipArchiveError("invalidArchive", "Central directory entries exceed their declared size.");
      }
    }
    if (offset !== centralEnd) {
      throw new ZipArchiveError("invalidArchive", "Central directory size does not match its entries.");
    }
  }

  private addRecord(record: ZipRecord): void {
    const segments = record.path.split("/");
    let parentPath = "";
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      const directoryPath = parentPath ? `${parentPath}/${segment}` : segment;
      const existing = this.records.get(directoryPath);
      if (existing?.type === "file") {
        throw new ZipArchiveError(
          "invalidArchive",
          `ZIP path '${directoryPath}' is both a file and a directory.`
        );
      }
      if (!existing) {
        this.records.set(directoryPath, {
          type: "directory",
          path: directoryPath,
          children: new Map(),
          mtime: record.mtime
        });
        this.addChild(parentPath, segment, "directory");
      }
      parentPath = directoryPath;
    }

    const name = segments[segments.length - 1];
    const existing = this.records.get(record.path);
    if (existing) {
      if (existing.type !== record.type || record.type === "file") {
        throw new ZipArchiveError("invalidArchive", `Duplicate ZIP entry path '${record.path}'.`);
      }
      existing.mtime = Math.max(existing.mtime, record.mtime);
    } else {
      this.records.set(record.path, record);
    }
    this.addChild(parentPath, name, record.type);
  }

  private addChild(parentPath: string, name: string, type: ZipArchiveEntryType): void {
    const parent = this.records.get(parentPath);
    if (!parent || parent.type !== "directory") {
      throw new ZipArchiveError("invalidArchive", `ZIP parent directory is missing: ${parentPath}`);
    }
    const existingType = parent.children.get(name);
    if (existingType && existingType !== type) {
      throw new ZipArchiveError("invalidArchive", `ZIP path '${name}' has conflicting entry types.`);
    }
    parent.children.set(name, type);
  }

  private compressedEntryBytes(record: ZipFileRecord): Buffer {
    assertAvailable(this.bytes, record.localHeaderOffset, 30, "local file header");
    if (this.bytes.readUInt32LE(record.localHeaderOffset) !== localFileHeaderSignature) {
      throw new ZipArchiveError(
        "invalidArchive",
        `Invalid local file header for ZIP entry '${record.path}'.`
      );
    }
    const fileNameLength = this.bytes.readUInt16LE(record.localHeaderOffset + 26);
    const extraLength = this.bytes.readUInt16LE(record.localHeaderOffset + 28);
    const dataOffset = checkedAdd(
      record.localHeaderOffset,
      30 + fileNameLength + extraLength,
      this.bytes.byteLength,
      `local file header for '${record.path}'`
    );
    const dataEnd = checkedAdd(
      dataOffset,
      record.compressedSize,
      this.bytes.byteLength,
      `compressed data for '${record.path}'`
    );
    return this.bytes.subarray(dataOffset, dataEnd);
  }
}

function locateCentralDirectory(bytes: Buffer): CentralDirectoryLocation {
  if (bytes.byteLength < 22) {
    throw new ZipArchiveError("invalidArchive", "ZIP archive is shorter than its end record.");
  }
  const minimumOffset = Math.max(0, bytes.byteLength - maximumEndRecordSearch);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset--) {
    if (bytes.readUInt32LE(offset) !== endOfCentralDirectorySignature) {
      continue;
    }
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== bytes.byteLength) {
      continue;
    }
    const diskNumber = bytes.readUInt16LE(offset + 4);
    const centralDirectoryDisk = bytes.readUInt16LE(offset + 6);
    const entriesOnDisk = bytes.readUInt16LE(offset + 8);
    const entryCount = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 12);
    const centralOffset = bytes.readUInt32LE(offset + 16);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ZipArchiveError("invalidArchive", "Multi-disk ZIP archives are unsupported.");
    }
    if (entryCount !== 0xffff && size !== 0xffffffff && centralOffset !== 0xffffffff) {
      checkedAdd(centralOffset, size, bytes.byteLength, "central directory");
      return { entryCount, size, offset: centralOffset };
    }
    return locateZip64CentralDirectory(bytes, offset);
  }
  throw new ZipArchiveError("invalidArchive", "ZIP end-of-central-directory record was not found.");
}

function locateZip64CentralDirectory(bytes: Buffer, endRecordOffset: number): CentralDirectoryLocation {
  const locatorOffset = endRecordOffset - 20;
  assertAvailable(bytes, locatorOffset, 20, "ZIP64 end-of-central-directory locator");
  if (bytes.readUInt32LE(locatorOffset) !== zip64EndOfCentralDirectoryLocatorSignature) {
    throw new ZipArchiveError("invalidArchive", "ZIP64 locator was not found.");
  }
  if (bytes.readUInt32LE(locatorOffset + 4) !== 0 || bytes.readUInt32LE(locatorOffset + 16) !== 1) {
    throw new ZipArchiveError("invalidArchive", "Multi-disk ZIP64 archives are unsupported.");
  }
  const zip64Offset = readUInt64Safe(bytes, locatorOffset + 8, "ZIP64 end record offset");
  assertAvailable(bytes, zip64Offset, 56, "ZIP64 end-of-central-directory record");
  if (bytes.readUInt32LE(zip64Offset) !== zip64EndOfCentralDirectorySignature) {
    throw new ZipArchiveError("invalidArchive", "ZIP64 end-of-central-directory record was not found.");
  }
  if (bytes.readUInt32LE(zip64Offset + 16) !== 0 || bytes.readUInt32LE(zip64Offset + 20) !== 0) {
    throw new ZipArchiveError("invalidArchive", "Multi-disk ZIP64 archives are unsupported.");
  }
  const entriesOnDisk = readUInt64Safe(bytes, zip64Offset + 24, "ZIP64 entries on disk");
  const entryCount = readUInt64Safe(bytes, zip64Offset + 32, "ZIP64 entry count");
  if (entriesOnDisk !== entryCount) {
    throw new ZipArchiveError("invalidArchive", "Multi-disk ZIP64 archives are unsupported.");
  }
  const size = readUInt64Safe(bytes, zip64Offset + 40, "ZIP64 central directory size");
  const offset = readUInt64Safe(bytes, zip64Offset + 48, "ZIP64 central directory offset");
  checkedAdd(offset, size, bytes.byteLength, "ZIP64 central directory");
  return { entryCount, size, offset };
}

function resolveZip64Fields(
  extra: Buffer,
  compressedSize32: number,
  uncompressedSize32: number,
  localHeaderOffset32: number
): Zip64ResolvedFields {
  const requiresZip64 = compressedSize32 === 0xffffffff
    || uncompressedSize32 === 0xffffffff
    || localHeaderOffset32 === 0xffffffff;
  if (!requiresZip64) {
    return {
      compressedSize: compressedSize32,
      uncompressedSize: uncompressedSize32,
      localHeaderOffset: localHeaderOffset32
    };
  }

  let field: Buffer | undefined;
  for (let offset = 0; offset + 4 <= extra.byteLength;) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    assertAvailable(extra, offset + 4, size, "ZIP extra field");
    if (id === zip64ExtraFieldId) {
      field = extra.subarray(offset + 4, offset + 4 + size);
      break;
    }
    offset += 4 + size;
  }
  if (!field) {
    throw new ZipArchiveError("invalidArchive", "ZIP64 entry is missing its extended information field.");
  }

  let cursor = 0;
  const readOptional = (required: boolean, fallback: number, label: string): number => {
    if (!required) {
      return fallback;
    }
    const result = readUInt64Safe(field!, cursor, label);
    cursor += 8;
    return result;
  };
  const uncompressedSize = readOptional(
    uncompressedSize32 === 0xffffffff,
    uncompressedSize32,
    "ZIP64 uncompressed size"
  );
  const compressedSize = readOptional(
    compressedSize32 === 0xffffffff,
    compressedSize32,
    "ZIP64 compressed size"
  );
  const localHeaderOffset = readOptional(
    localHeaderOffset32 === 0xffffffff,
    localHeaderOffset32,
    "ZIP64 local header offset"
  );
  return { compressedSize, uncompressedSize, localHeaderOffset };
}

function normalizeArchiveEntryPath(value: string): { path: string; directory: boolean } {
  if (value.includes("\0")) {
    throw new ZipArchiveError("invalidArchive", "ZIP entry name contains a NUL byte.");
  }
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[a-z]:\//i.test(slashPath)) {
    throw new ZipArchiveError("invalidArchive", `ZIP entry uses an absolute path: ${value}`);
  }
  const directory = slashPath.endsWith("/");
  const segments = slashPath.split("/").filter(segment => segment !== "" && segment !== ".");
  if (segments.some(segment => segment === "..")) {
    throw new ZipArchiveError("invalidArchive", `ZIP entry escapes the archive root: ${value}`);
  }
  return { path: segments.join("/"), directory };
}

function normalizeLookupPath(value: string): string {
  const slashPath = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!slashPath) {
    return "";
  }
  const segments = slashPath.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new ZipArchiveError("entryNotFound", `Invalid ZIP lookup path: ${value}`);
  }
  return segments.join("/");
}

function decodeFileName(bytes: Buffer, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ZipArchiveError("invalidArchive", "ZIP entry has an invalid UTF-8 file name.");
    }
  }
  // Resource-pack paths are conventionally ASCII. Latin-1 preserves every
  // byte for uncommon legacy archives instead of silently replacing names.
  return bytes.toString("latin1");
}

function dosDateTime(date: number, time: number): number {
  if (date === 0) {
    return 0;
  }
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  return Date.UTC(year, Math.max(0, month), Math.max(1, day), hour, minute, second);
}

function readUInt64Safe(bytes: Buffer, offset: number, label: string): number {
  assertAvailable(bytes, offset, 8, label);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipArchiveError("invalidArchive", `${label} exceeds JavaScript's safe integer range.`);
  }
  return Number(value);
}

function checkedAdd(start: number, length: number, limit: number, label: string): number {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    throw new ZipArchiveError("invalidArchive", `Invalid ${label} bounds.`);
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > limit) {
    throw new ZipArchiveError("invalidArchive", `${label} exceeds the ZIP archive bounds.`);
  }
  return end;
}

function assertAvailable(bytes: Buffer, offset: number, length: number, label: string): void {
  checkedAdd(offset, length, bytes.byteLength, label);
}

let crc32Table: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const table = crc32Table ??= createCrc32Table();
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
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
