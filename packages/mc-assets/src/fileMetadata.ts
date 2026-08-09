import * as fs from "node:fs";
import {
  oggMaximumPageBytes,
  oggVorbisIdentificationPageBytes,
  readOggMetadataFromHeadAndTail,
  type OggMetadata
} from "./oggMetadata";
import { pngMetadataHeaderBytes, readPngMetadata, type PngMetadata } from "./pngMetadata";

export function readPngFileMetadata(fileName: string): PngMetadata | null {
  try {
    return readPngMetadata(readFilePrefix(fileName, pngMetadataHeaderBytes));
  } catch {
    return null;
  }
}

export function readOggFileMetadata(fileName: string): OggMetadata | null {
  const handle = openFile(fileName);
  if (handle === null) {
    return null;
  }
  try {
    const fileSize = fs.fstatSync(handle).size;
    const head = readFileRange(
      handle,
      0,
      Math.min(fileSize, oggVorbisIdentificationPageBytes)
    );
    const tailLength = Math.min(fileSize, oggMaximumPageBytes);
    const tail = readFileRange(handle, fileSize - tailLength, tailLength);
    return readOggMetadataFromHeadAndTail(head, tail);
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function readFilePrefix(fileName: string, byteLength: number): Buffer {
  const handle = fs.openSync(fileName, "r");
  try {
    return readFileRange(handle, 0, byteLength);
  } finally {
    fs.closeSync(handle);
  }
}

function openFile(fileName: string): number | null {
  try {
    return fs.openSync(fileName, "r");
  } catch {
    return null;
  }
}

function readFileRange(handle: number, position: number, byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  const bytesRead = fs.readSync(handle, bytes, 0, byteLength, position);
  return bytes.subarray(0, bytesRead);
}
