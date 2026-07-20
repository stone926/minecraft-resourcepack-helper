import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRsglEmittedFiles,
  type RsglBuildWriteHost
} from "../../rsgl/host/commands/asyncBuildWriter";
import {
  RsglCopySourceReadError,
  RsglUnsafeOutputPathError
} from "../../rsgl/host/commands/buildUiErrors";
import type { RsglEmittedFile } from "../../../packages/rsgl-core/src/compiler";

describe("RSGL async build writer", () => {
  it("uses the ownership transaction and emits one contentless invalidation", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-async-write-");
    const outputRoot = path.join(root, "资源 pack");
    const invalidations: unknown[] = [];
    const files: RsglEmittedFile[] = [
      { outputPath: "assets/demo/models/item/generated.json", content: "{}\n", kind: "resource" }
    ];

    try {
      const first = await applyRsglEmittedFiles(files, outputRoot, {
        cancellationToken: { isCancellationRequested: false },
        sourceIdentity: path.join(root, "源 files"),
        transactionId: "async-create",
        onInvalidation: invalidation => { invalidations.push(invalidation); }
      });
      const second = await applyRsglEmittedFiles(files, outputRoot, {
        cancellationToken: { isCancellationRequested: false },
        sourceIdentity: path.join(root, "源 files"),
        transactionId: "async-unchanged"
      });
      const committedWithConsumerFailure = await applyRsglEmittedFiles(
        [{ ...files[0], content: "{\"updated\":true}\n" }],
        outputRoot,
        {
          cancellationToken: { isCancellationRequested: false },
          sourceIdentity: path.join(root, "源 files"),
          transactionId: "async-consumer-failure",
          onInvalidation: () => { throw new Error("consumer unavailable"); }
        }
      );

      assert.strictEqual(first.status, "committed");
      assert.deepStrictEqual(first.preview.writePlan.summary, { create: 1, update: 0, unchanged: 0 });
      assert.deepStrictEqual(second.preview.writePlan.summary, { create: 0, update: 0, unchanged: 1 });
      assert.strictEqual(committedWithConsumerFailure.status, "committed");
      assert.strictEqual(committedWithConsumerFailure.invalidationDeliveryFailure, "consumer unavailable");
      assert.strictEqual(invalidations.length, 1);
      assert.strictEqual("content" in (invalidations[0] as object), false);
      assert.strictEqual(fs.readFileSync(path.join(outputRoot, "assets", "demo", "models", "item", "generated.json"), "utf8"), "{\"updated\":true}\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe output paths before performing host I/O", async () => {
    let reads = 0;
    const host = emptyHost({
      readFile: async () => {
        reads++;
        return undefined;
      }
    });

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "../escape.json", content: "unsafe", kind: "resource" }],
      "pack",
      {
        cancellationToken: { isCancellationRequested: false },
        sourceIdentity: "rsgl"
      },
      host
    ), error => error instanceof RsglUnsafeOutputPathError && error.outputPath === "../escape.json");
    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: ".rsgl/manifests/hijack.json", content: "unsafe", kind: "resource" }],
      "pack",
      {
        cancellationToken: { isCancellationRequested: false },
        sourceIdentity: "rsgl"
      },
      host
    ), error => error instanceof RsglUnsafeOutputPathError);
    assert.strictEqual(reads, 0);
  });

  it("preserves a structured copy-source read error", async () => {
    const copyFrom = path.resolve("missing-pack.png");
    const readFailure = new Error("technical copy-source read failure");
    const host = emptyHost({
      readFile: async fileName => {
        if (fileName === copyFrom) {
          throw readFailure;
        }
        return undefined;
      }
    });

    await assert.rejects(() => applyRsglEmittedFiles(
      [{ outputPath: "pack.png", copyFrom, kind: "resource" }],
      "pack",
      {
        cancellationToken: { isCancellationRequested: false },
        sourceIdentity: "rsgl"
      },
      host
    ), error =>
      error instanceof RsglCopySourceReadError &&
      error.copyFrom === copyFrom &&
      error.cause === readFailure
    );
  });
});

function emptyHost(overrides: Partial<RsglBuildWriteHost> = {}): RsglBuildWriteHost {
  return {
    readFile: async () => undefined,
    readDirectory: async () => [],
    createDirectory: async () => undefined,
    writeFile: async () => undefined,
    replaceFile: async () => undefined,
    deleteFile: async () => undefined,
    deleteDirectory: async () => undefined,
    ...overrides
  };
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
