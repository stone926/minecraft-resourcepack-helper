export interface PngMetadata {
  width: number;
  height: number;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngMetadata(bytes: Uint8Array): PngMetadata | null {
  if (bytes.length < 24 || !Buffer.from(bytes.subarray(0, pngSignature.length)).equals(pngSignature)) {
    return null;
  }

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}
