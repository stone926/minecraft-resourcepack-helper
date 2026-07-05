import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue, ResourceUnit, RsglEmittedFile } from "../../src/compiler";

export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-"));
}

export function emittedContent(file: RsglEmittedFile | undefined): string {
  if (!file || !("content" in file)) {
    throw new Error("Expected emitted content file.");
  }
  return file.content;
}

export function minimalItemUnit(content: Record<string, JsonValue>): ResourceUnit {
  return {
    id: { namespace: "minecraft", path: "test_item" },
    kind: "item",
    outputPath: "assets/minecraft/items/test_item.json",
    content,
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: {
      generatedFile: "assets/minecraft/items/test_item.json",
      mappings: [{
        generatedPath: "",
        sourceFile: "test.rsgl",
        sourceRange: { start: 0, end: 1 },
        reason: "direct",
        expansionStack: []
      }]
    }
  };
}

export function createPngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
