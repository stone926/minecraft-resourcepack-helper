import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRsglEmittedFiles,
  type RsglBuildWriteHost
} from "../../src/commands/asyncBuildWriter";
import {
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "../../src/commands/buildUiErrors";
import type { RsglEmittedFile } from "../../../../packages/rsgl-core/src/compiler";

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
    ), error => error instanceof RsglUnsafeOutputPathError && error.outputPath === "../escape.json");
    assert.strictEqual(reads, 0);
  });

  it("reports an unreadable existing output as a structured UI error", async () => {
    const readFailure = new Error("technical read failure");
    const host: RsglBuildWriteHost = {
      readText: async () => { throw readFailure; },
      readBytes: async () => undefined,
      createDirectory: async () => undefined,
      writeText: async () => undefined,
      copyFile: async () => undefined
    };
    const outputRoot = path.resolve("pack");
    const expectedFileName = path.join(outputRoot, "generated.json");

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "generated.json", content: "{}", kind: "resource" }],
      outputRoot,
      { isCancellationRequested: false },
      host
    ), error =>
      error instanceof RsglOutputFileReadError &&
      error.fileName === expectedFileName &&
      error.cause === readFailure
    );
  });

  it("reports an unreadable copy source as a structured UI error", async () => {
    const copyFrom = path.resolve("missing-pack.png");
    const readFailure = new Error("technical copy-source read failure");
    const host: RsglBuildWriteHost = {
      readText: async () => undefined,
      readBytes: async fileName => {
        if (fileName === copyFrom) {
          throw readFailure;
        }
        return undefined;
      },
      createDirectory: async () => undefined,
      writeText: async () => undefined,
      copyFile: async () => undefined
    };

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "pack.png", copyFrom, kind: "resource" }],
      "pack",
      { isCancellationRequested: false },
      host
    ), error =>
      error instanceof RsglCopySourceReadError &&
      error.copyFrom === copyFrom &&
      error.cause === readFailure
    );
  });

  it("reports an unreadable existing binary output as a structured UI error", async () => {
    const outputRoot = path.resolve("pack");
    const outputFile = path.join(outputRoot, "pack.png");
    const copyFrom = path.resolve("source-pack.png");
    const readFailure = new Error("technical binary output read failure");
    const host: RsglBuildWriteHost = {
      readText: async () => undefined,
      readBytes: async fileName => {
        if (fileName === copyFrom) {
          return new Uint8Array([1, 2, 3]);
        }
        throw readFailure;
      },
      createDirectory: async () => undefined,
      writeText: async () => undefined,
      copyFile: async () => undefined
    };

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "pack.png", copyFrom, kind: "resource" }],
      outputRoot,
      { isCancellationRequested: false },
      host
    ), error =>
      error instanceof RsglOutputFileReadError &&
      error.fileName === outputFile &&
      error.cause === readFailure
    );
  });

  it("preserves a structured copy-source error when the source disappears before commit", async () => {
    const copyFailure = Object.assign(new Error("technical ENOENT detail"), { code: "ENOENT" });
    let readCount = 0;
    const host: RsglBuildWriteHost = {
      readText: async () => undefined,
      readBytes: async () => readCount++ === 0 ? undefined : new Uint8Array([1, 2, 3]),
      createDirectory: async () => undefined,
      writeText: async () => undefined,
      copyFile: async () => { throw copyFailure; }
    };
    const copyFrom = path.resolve("vanishing-pack.png");

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "pack.png", copyFrom, kind: "resource" }],
      "pack",
      { isCancellationRequested: false },
      host
    ), error =>
      error instanceof RsglCopySourceReadError &&
      error.copyFrom === copyFrom &&
      error.cause === copyFailure
    );
  });
});

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
