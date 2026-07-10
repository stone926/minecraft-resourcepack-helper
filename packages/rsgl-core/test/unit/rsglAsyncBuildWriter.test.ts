import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyRsglEmittedFiles,
  type RsglBuildWriteHost
} from "../../../../extensions/vscode-rsgl/src/commands/asyncBuildWriter";
import type { RsglEmittedFile } from "../../src/compiler";
import { createTempDir } from "./helpers/fs";

describe("RSGL async build writer", () => {
  it("writes text and copy outputs asynchronously with accurate summaries", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-async-write-");
    const outputRoot = path.join(root, "pack");
    const copySource = path.join(root, "pack.png");
    const files: RsglEmittedFile[] = [
      { outputPath: "generated.txt", content: "generated", kind: "resource" },
      { outputPath: "pack.png", copyFrom: copySource, kind: "resource" }
    ];

    try {
      fs.writeFileSync(copySource, Buffer.from([1, 2, 3]));
      const first = await applyRsglEmittedFiles(files, outputRoot, { isCancellationRequested: false });
      const second = await applyRsglEmittedFiles(files, outputRoot, { isCancellationRequested: false });

      assert.deepStrictEqual(first?.summary, { create: 2, update: 0, unchanged: 0 });
      assert.deepStrictEqual(second?.summary, { create: 0, update: 0, unchanged: 2 });
      assert.strictEqual(fs.readFileSync(path.join(outputRoot, "generated.txt"), "utf8"), "generated");
      assert.deepStrictEqual([...fs.readFileSync(path.join(outputRoot, "pack.png"))], [1, 2, 3]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops before writing later files when cancellation arrives during commit", async () => {
    const cancellation = { isCancellationRequested: false };
    const writes: string[] = [];
    const host: RsglBuildWriteHost = {
      readText: async () => undefined,
      readBytes: async () => undefined,
      createDirectory: async () => undefined,
      writeText: async fileName => {
        writes.push(fileName);
        cancellation.isCancellationRequested = true;
      },
      copyFile: async () => undefined
    };
    const files: RsglEmittedFile[] = [
      { outputPath: "first.json", content: "first", kind: "resource" },
      { outputPath: "second.json", content: "second", kind: "resource" }
    ];

    const plan = await applyRsglEmittedFiles(files, "pack", cancellation, host);

    assert.strictEqual(plan, null);
    assert.deepStrictEqual(writes, [path.resolve("pack", "first.json")]);
  });

  it("rejects unsafe output paths before performing I/O", async () => {
    let reads = 0;
    const host: RsglBuildWriteHost = {
      readText: async () => {
        reads++;
        return undefined;
      },
      readBytes: async () => undefined,
      createDirectory: async () => undefined,
      writeText: async () => undefined,
      copyFile: async () => undefined
    };

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "../escape.json", content: "unsafe", kind: "resource" }],
      "pack",
      { isCancellationRequested: false },
      host
    ), /Unsafe RSGL output path/);
    assert.strictEqual(reads, 0);
  });
});
