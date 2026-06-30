import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { ModelPreviewService } from "../out/modelPreview/service/ModelPreviewService.js";

function writeFile(root, relativePath, value) {
  const fileName = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, value);
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, JSON.stringify(value));
}

function createElements(count) {
  return Array.from({ length: count }, (_, index) => {
    const x = index % 25;
    const y = Math.floor(index / 25) % 20;
    return {
      from: [x % 16, y % 16, 0],
      to: [(x % 16) + 0.5, (y % 16) + 0.5, 0.5],
      faces: {
        north: { texture: "#all" }
      }
    };
  });
}

function createRgbaPng(width, height) {
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
      rows[offset + 3] = 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
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
    for (let bit = 0; bit < 8; bit++) {
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

function createBenchmarkFixtures(root) {
  writeJson(root, "pack.mcmeta", {
    pack: {
      min_format: [88, 0],
      max_format: [88, 0],
      description: "model preview benchmark"
    }
  });
  writeFile(root, "assets/minecraft/textures/block/stone.png", "png");
  writeFile(root, "assets/minecraft/textures/item/generated.png", createRgbaPng(32, 32));
  writeJson(root, "assets/minecraft/models/block/simple.json", {
    textures: { all: "minecraft:block/stone" },
    elements: createElements(1)
  });
  writeJson(root, "assets/minecraft/models/block/parent0.json", {
    textures: { all: "minecraft:block/stone" },
    elements: createElements(4)
  });
  for (let index = 1; index <= 8; index++) {
    writeJson(root, `assets/minecraft/models/block/parent${index}.json`, {
      parent: `minecraft:block/parent${index - 1}`,
      textures: { all: "minecraft:block/stone" }
    });
  }
  writeJson(root, "assets/minecraft/models/block/elements500.json", {
    textures: { all: "minecraft:block/stone" },
    elements: createElements(500)
  });
  writeJson(root, "assets/minecraft/models/item/generated.json", {
    parent: "minecraft:item/generated",
    textures: { layer0: "minecraft:item/generated" }
  });

  return {
    simple: "assets/minecraft/models/block/simple.json",
    parentChain8: "assets/minecraft/models/block/parent8.json",
    elements500: "assets/minecraft/models/block/elements500.json",
    generatedTextureAlpha: "assets/minecraft/models/item/generated.json"
  };
}

async function measure(root, relativePath) {
  const service = new ModelPreviewService();
  const fileName = path.join(root, relativePath);
  const first = await time(() => service.getPreviewDocument(fileName));
  service.invalidate(fileName);
  const hot = await time(() => service.getPreviewDocument(fileName));
  return { first, hot };
}

async function time(action) {
  const start = performance.now();
  await action();
  return performance.now() - start;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-rph-model-preview-benchmark-"));
try {
  const fixtures = createBenchmarkFixtures(root);
  const rows = [
    ["simple", await measure(root, fixtures.simple)],
    ["parent-chain-8", await measure(root, fixtures.parentChain8)],
    ["elements-500", await measure(root, fixtures.elements500)],
    ["generated-texture-alpha", await measure(root, fixtures.generatedTextureAlpha)]
  ];

  console.log("fixture,first_ir_ms,hot_refresh_ms");
  for (const [fixture, result] of rows) {
    console.log(`${fixture},${result.first.toFixed(3)},${result.hot.toFixed(3)}`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
