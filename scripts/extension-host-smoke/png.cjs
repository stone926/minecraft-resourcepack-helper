const zlib = require("node:zlib");

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const rgbaBytesPerPixel = 4;
const opaqueAlphaThreshold = 224;
const minimumOpaqueRatio = 0.02;
const minimumBoundsRatio = 0.2;
const minimumSentinelColorRatio = 0.002;

function createCheckerTexturePng(width = 16, height = 16) {
  assertDimension(width, "width");
  assertDimension(height, "height");
  const rgba = Buffer.alloc(checkedRgbaByteLength(width, height));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * rgbaBytesPerPixel;
      const red = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      rgba[offset] = red ? 255 : 32;
      rgba[offset + 1] = red ? 32 : 255;
      rgba[offset + 2] = red ? 32 : 64;
      rgba[offset + 3] = 255;
    }
  }

  return createRgbaPng(width, height, rgba);
}

function createRgbaPng(width, height, value) {
  assertDimension(width, "width");
  assertDimension(height, "height");
  const rgba = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const expectedBytes = checkedRgbaByteLength(width, height);
  if (rgba.length !== expectedBytes) {
    throw new Error(`RGBA payload must contain exactly ${expectedBytes} bytes.`);
  }

  const rowBytes = width * rgbaBytesPerPixel;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (rowBytes + 1);
    rows[rowOffset] = 0;
    rgba.copy(rows, rowOffset + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function analyzeRenderedModelPng(value) {
  const image = decodeRgbaPng(value);
  let opaquePixels = 0;
  let redDominantPixels = 0;
  let greenDominantPixels = 0;
  let magentaDominantPixels = 0;
  let blackPixels = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * rgbaBytesPerPixel;
      const red = image.rgba[offset];
      const green = image.rgba[offset + 1];
      const blue = image.rgba[offset + 2];
      const alpha = image.rgba[offset + 3];
      if (alpha < opaqueAlphaThreshold) {
        continue;
      }
      opaquePixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (red >= 96 && red >= green + 40 && red >= blue + 40) {
        redDominantPixels += 1;
      }
      if (green >= 96 && green >= red + 40 && green >= blue + 20) {
        greenDominantPixels += 1;
      }
      if (red >= 80 && blue >= 80 && red >= green + 40 && blue >= green + 40) {
        magentaDominantPixels += 1;
      }
      if (red <= 40 && green <= 40 && blue <= 40) {
        blackPixels += 1;
      }
    }
  }

  return {
    width: image.width,
    height: image.height,
    opaquePixels,
    opaqueRatio: opaquePixels / (image.width * image.height),
    opaqueBounds: opaquePixels === 0
      ? null
      : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    redDominantPixels,
    greenDominantPixels,
    magentaDominantPixels,
    blackPixels
  };
}

function assertRenderedCheckerTexture(analysis) {
  assertRenderedGeometry(analysis);
  const minimumColorPixels = sentinelColorMinimum(analysis);
  if (analysis.redDominantPixels < minimumColorPixels || analysis.greenDominantPixels < minimumColorPixels) {
    throw new Error(`Model preview did not render the checker texture colors: ${JSON.stringify(analysis)}`);
  }
}

function assertRenderedMissingTexture(analysis) {
  assertRenderedGeometry(analysis);
  const minimumColorPixels = sentinelColorMinimum(analysis);
  if (analysis.magentaDominantPixels < minimumColorPixels || analysis.blackPixels < minimumColorPixels) {
    throw new Error(`Model preview did not render the failed texture fallback: ${JSON.stringify(analysis)}`);
  }
}

function assertRenderedGeometry(analysis) {
  const minimumOpaquePixels = Math.ceil(analysis.width * analysis.height * minimumOpaqueRatio);
  if (analysis.opaquePixels < minimumOpaquePixels) {
    throw new Error(`Model preview rendered too little opaque geometry: ${JSON.stringify(analysis)}`);
  }
  if (
    !analysis.opaqueBounds
    || analysis.opaqueBounds.width < analysis.width * minimumBoundsRatio
    || analysis.opaqueBounds.height < analysis.height * minimumBoundsRatio
  ) {
    throw new Error(`Model preview geometry bounds are unexpectedly small: ${JSON.stringify(analysis)}`);
  }
}

function sentinelColorMinimum(analysis) {
  return Math.ceil(analysis.width * analysis.height * minimumSentinelColorRatio);
}

function decodeRgbaPng(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error("Screenshot is not a PNG file.");
  }

  let offset = pngSignature.length;
  let width;
  let height;
  const compressed = [];
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("Screenshot PNG contains a truncated chunk.");
    }
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      throw new Error("Screenshot PNG chunk exceeds the file boundary.");
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (expectedCrc !== actualCrc) {
      throw new Error(`Screenshot PNG chunk ${type} has an invalid CRC.`);
    }
    if (type === "IHDR") {
      if (length !== 13 || width !== undefined) {
        throw new Error("Screenshot PNG has an invalid IHDR chunk.");
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Screenshot PNG must be non-interlaced 8-bit RGBA.");
      }
      assertDimension(width, "PNG width");
      assertDimension(height, "PNG height");
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawEnd || offset !== bytes.length || width === undefined || compressed.length === 0) {
    throw new Error("Screenshot PNG is missing required chunks or has trailing bytes.");
  }
  const rowBytes = width * rgbaBytesPerPixel;
  checkedRgbaByteLength(width, height);
  const expectedInflatedBytes = (rowBytes + 1) * height;
  const filtered = zlib.inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expectedInflatedBytes
  });
  if (filtered.length !== expectedInflatedBytes) {
    throw new Error("Screenshot PNG has an unexpected inflated size.");
  }

  const rgba = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filteredOffset = y * (rowBytes + 1);
    const filter = filtered[filteredOffset];
    for (let x = 0; x < rowBytes; x += 1) {
      const source = filtered[filteredOffset + 1 + x];
      const targetOffset = y * rowBytes + x;
      const left = x >= rgbaBytesPerPixel ? rgba[targetOffset - rgbaBytesPerPixel] : 0;
      const above = y > 0 ? rgba[targetOffset - rowBytes] : 0;
      const upperLeft = y > 0 && x >= rgbaBytesPerPixel
        ? rgba[targetOffset - rowBytes - rgbaBytesPerPixel]
        : 0;
      rgba[targetOffset] = unfilterByte(filter, source, left, above, upperLeft);
    }
  }
  return { width, height, rgba };
}

function unfilterByte(filter, source, left, above, upperLeft) {
  switch (filter) {
    case 0:
      return source;
    case 1:
      return source + left;
    case 2:
      return source + above;
    case 3:
      return source + Math.floor((left + above) / 2);
    case 4:
      return source + paeth(left, above, upperLeft);
    default:
      throw new Error(`Screenshot PNG uses unsupported filter ${filter}.`);
  }
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  const table = crc32.table ??= Array.from({ length: 256 }, (_, value) => {
    let checksum = value;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
    }
    return checksum >>> 0;
  });
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function assertDimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8192) {
    throw new Error(`${label} must be an integer between 1 and 8192.`);
  }
}

function checkedRgbaByteLength(width, height) {
  const byteLength = width * height * rgbaBytesPerPixel;
  if (!Number.isSafeInteger(byteLength) || byteLength > 64 * 1024 * 1024) {
    throw new Error("PNG dimensions exceed the smoke analyzer memory limit.");
  }
  return byteLength;
}

module.exports = {
  analyzeRenderedModelPng,
  assertRenderedCheckerTexture,
  assertRenderedGeometry,
  assertRenderedMissingTexture,
  createCheckerTexturePng,
  createRgbaPng
};
