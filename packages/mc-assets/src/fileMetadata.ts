import * as fs from "node:fs";
import { readOggMetadata, type OggMetadata } from "./oggMetadata";
import { pngMetadataHeaderBytes, readPngMetadata, type PngMetadata } from "./pngMetadata";

export function readPngFileMetadata(fileName: string): PngMetadata | null {
  try {
    return readPngMetadata(readFilePrefix(fileName, pngMetadataHeaderBytes));
  } catch {
    return null;
  }
}

export function readOggFileMetadata(fileName: string): OggMetadata | null {
  try {
    return readOggMetadata(fs.readFileSync(fileName));
  } catch {
    return null;
  }
}

function readFilePrefix(fileName: string, byteLength: number): Buffer {
  const handle = fs.openSync(fileName, "r");
  try {
    const bytes = Buffer.allocUnsafe(byteLength);
    const bytesRead = fs.readSync(handle, bytes, 0, byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    fs.closeSync(handle);
  }
}
