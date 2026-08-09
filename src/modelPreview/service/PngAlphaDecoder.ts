import type { PngAlphaMask } from "../bake/AlphaMask";

interface PngData {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  palette: number[];
  paletteAlpha: number[];
  transparentColor: number[] | null;
  idat: Buffer[];
}

export type PngIdatInflater = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface PngAlphaDecodeOptions {
  maxInputBytes?: number;
  maxInflatedBytes?: number;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function readPngAlphaMask(
  bytes: Uint8Array,
  inflateIdat: PngIdatInflater,
  options: PngAlphaDecodeOptions = {}
): Promise<PngAlphaMask | null> {
  if (options.maxInputBytes !== undefined && bytes.byteLength > options.maxInputBytes) {
    return null;
  }

  const data = parsePng(bytes);
  if (!data || !isSupportedBitDepth(data)) {
    return null;
  }

  const bytesPerPixel = getBytesPerPixel(data.colorType);
  if (bytesPerPixel === 0) {
    return null;
  }

  const rowBytes = getRowBytes(data);
  const expectedBytes = data.height * (rowBytes + 1);
  if (!Number.isSafeInteger(rowBytes) || !Number.isSafeInteger(expectedBytes)) {
    return null;
  }
  if (options.maxInflatedBytes !== undefined && expectedBytes > options.maxInflatedBytes) {
    return null;
  }

  let inflated: Uint8Array;
  try {
    inflated = await inflateIdat(Buffer.concat(data.idat));
  } catch {
    return null;
  }

  const pixels = unfilterRows(Buffer.from(inflated.buffer, inflated.byteOffset, inflated.byteLength), data.height, rowBytes, bytesPerPixel);
  if (!pixels) {
    return null;
  }

  return {
    width: data.width,
    height: data.height,
    isOpaque: (x, y) => getAlpha(data, pixels, x, y, bytesPerPixel) > 0
  };
}

function parsePng(bytes: Uint8Array): PngData | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    return null;
  }

  const data: PngData = {
    width: 0,
    height: 0,
    bitDepth: 0,
    colorType: 0,
    palette: [],
    paletteAlpha: [],
    transparentColor: null,
    idat: []
  };

  let offset = pngSignature.length;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd + 4 > buffer.length) {
      return null;
    }

    const chunk = buffer.subarray(chunkStart, chunkEnd);
    if (type === "IHDR") {
      if (sawHeader || chunk.length !== 13) {
        return null;
      }
      sawHeader = true;
      data.width = chunk.readUInt32BE(0);
      data.height = chunk.readUInt32BE(4);
      data.bitDepth = chunk[8];
      data.colorType = chunk[9];
      if (chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0 || data.width <= 0 || data.height <= 0) {
        return null;
      }
    } else if (type === "PLTE") {
      if (!sawHeader || chunk.length === 0 || chunk.length % 3 !== 0 || chunk.length > 256 * 3) {
        return null;
      }
      data.palette = [...chunk];
    } else if (type === "tRNS") {
      if (data.colorType === 3) {
        if (chunk.length > data.palette.length / 3) {
          return null;
        }
        data.paletteAlpha = [...chunk];
      } else if (data.colorType === 0 && chunk.length === 2) {
        data.transparentColor = [chunk.readUInt16BE(0)];
      } else if (data.colorType === 2 && chunk.length === 6) {
        data.transparentColor = [chunk.readUInt16BE(0), chunk.readUInt16BE(2), chunk.readUInt16BE(4)];
      } else {
        return null;
      }
    } else if (type === "IDAT") {
      if (!sawHeader) {
        return null;
      }
      data.idat.push(chunk);
    } else if (type === "IEND") {
      if (chunk.length !== 0) {
        return null;
      }
      sawEnd = true;
      break;
    }

    offset = chunkEnd + 4;
  }

  return sawHeader && sawEnd && data.width > 0 && data.height > 0 && data.idat.length > 0
    ? data
    : null;
}

function getBytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 0;
  }
}

function isSupportedBitDepth(data: PngData): boolean {
  if (data.colorType === 3) {
    return data.palette.length > 0 &&
      (data.bitDepth === 1 || data.bitDepth === 2 || data.bitDepth === 4 || data.bitDepth === 8);
  }
  return data.bitDepth === 8;
}

function getRowBytes(data: PngData): number {
  if (data.colorType === 3 && data.bitDepth < 8) {
    return Math.ceil(data.width * data.bitDepth / 8);
  }
  return data.width * getBytesPerPixel(data.colorType);
}

function unfilterRows(inflated: Buffer, height: number, rowBytes: number, bytesPerPixel: number): Uint8Array | null {
  const expectedBytes = height * (rowBytes + 1);
  if (inflated.length !== expectedBytes) {
    return null;
  }

  const pixels = new Uint8Array(height * rowBytes);
  let readOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[readOffset++];
    if (filter > 4) {
      return null;
    }
    const rowOffset = y * rowBytes;
    const previousRowOffset = rowOffset - rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[readOffset++];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[previousRowOffset + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[previousRowOffset + x - bytesPerPixel] : 0;
      pixels[rowOffset + x] = (raw + filterDelta(filter, left, up, upLeft)) & 0xff;
    }
  }

  return pixels;
}

function filterDelta(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paeth(left, up, upLeft);
    default:
      return 0;
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

function getAlpha(data: PngData, pixels: Uint8Array, x: number, y: number, bytesPerPixel: number): number {
  const offset = (y * data.width + x) * bytesPerPixel;
  switch (data.colorType) {
    case 0:
      return matchesTransparentColor(data, [pixels[offset]]) ? 0 : 255;
    case 2:
      return matchesTransparentColor(data, [pixels[offset], pixels[offset + 1], pixels[offset + 2]]) ? 0 : 255;
    case 3:
      return data.paletteAlpha[getPaletteIndex(data, pixels, x, y)] ?? 255;
    case 4:
      return pixels[offset + 1];
    case 6:
      return pixels[offset + 3];
    default:
      return 0;
  }
}

function getPaletteIndex(data: PngData, pixels: Uint8Array, x: number, y: number): number {
  if (data.bitDepth === 8) {
    return pixels[y * data.width + x];
  }

  const rowBytes = getRowBytes(data);
  const byte = pixels[y * rowBytes + Math.floor(x * data.bitDepth / 8)];
  const shift = 8 - data.bitDepth - (x * data.bitDepth) % 8;
  return (byte >> shift) & ((1 << data.bitDepth) - 1);
}

function matchesTransparentColor(data: PngData, color: number[]): boolean {
  return !!data.transparentColor && data.transparentColor.every((component, index) => component === color[index]);
}
