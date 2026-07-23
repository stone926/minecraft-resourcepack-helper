import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createRsglOwnershipManifestV2,
  nodeAsyncMaterializationHost,
  rsglOwnershipManifestPath,
  runRsglMaterializationTransaction,
  runRsglMaterializationTransactionSync,
  serializeRsglOwnershipManifestV2,
  type RsglAsyncMaterializationHost,
  type RsglEmittedFile,
  type RsglMaterializationProject
} from "../../src/compiler";
import { createTempDir } from "./helpers/fs";

describe("RSGL materialization performance structure", () => {
  it("bounds parallel I/O, deduplicates parent creation, and keeps commit serialized", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-materialization-parallel-");
    const outputRoot = path.join(root, "pack");
    const copyRoot = path.join(root, "copy-sources");
    const project = materializationProject("parallel-project", "parallel-pack");
    const fileCount = 20;
    const outputParentCount = 10;
    const otherManifestCount = 12;
    const files: RsglEmittedFile[] = Array.from({ length: fileCount }, (_, index) => ({
      outputPath: [
        "assets",
        "demo",
        "models",
        "item",
        `group-${String(Math.floor(index / 2)).padStart(2, "0")}`,
        `file-${String(index).padStart(2, "0")}.json`
      ].join("/"),
      copyFrom: path.join(copyRoot, `source-${index}.json`),
      kind: "resource"
    }));
    const manifestDirectory = path.join(outputRoot, ".rsgl", "manifests");
    const stagingDirectory = path.join(outputRoot, ".rsgl", "staging");
    const assetsDirectory = path.join(outputRoot, "assets");
    fs.mkdirSync(manifestDirectory, { recursive: true });
    for (let index = 0; index < otherManifestCount; index++) {
      const manifest = createRsglOwnershipManifestV2({
        projectId: `other-project-${index}`,
        sourceRoot: "rsgl",
        outputPackRootIdentity: project.outputPackRootIdentity,
        buildRevision: `revision-${index}`,
        files: []
      });
      fs.writeFileSync(
        path.join(manifestDirectory, `other-project-${index}.json`),
        serializeRsglOwnershipManifestV2(manifest)
      );
    }

    const copyReads = new BatchedConcurrencyProbe(fileCount);
    const manifestReads = new BatchedConcurrencyProbe(otherManifestCount);
    const outputReads = new BatchedConcurrencyProbe(fileCount);
    const stagingDirectories = new BatchedConcurrencyProbe(outputParentCount + 1);
    const stagingWrites = new BatchedConcurrencyProbe(fileCount);
    const commitDirectories: string[] = [];
    const commitTargets: string[] = [];
    let commitActive = 0;
    let maximumCommitActive = 0;
    const host: RsglAsyncMaterializationHost = {
      ...nodeAsyncMaterializationHost,
      readFile: async fileName => {
        if (isWithin(copyRoot, fileName)) {
          return copyReads.observe(async () => Buffer.from(`copy:${path.basename(fileName)}`));
        }
        if (path.dirname(fileName) === manifestDirectory) {
          return manifestReads.observe(() => nodeAsyncMaterializationHost.readFile(fileName));
        }
        if (isWithin(assetsDirectory, fileName)) {
          return outputReads.observe(() => nodeAsyncMaterializationHost.readFile(fileName));
        }
        return nodeAsyncMaterializationHost.readFile(fileName);
      },
      createDirectory: async directory => {
        if (isWithin(stagingDirectory, directory)) {
          return stagingDirectories.observe(
            () => nodeAsyncMaterializationHost.createDirectory(directory)
          );
        }
        commitDirectories.push(directory);
        await nodeAsyncMaterializationHost.createDirectory(directory);
      },
      writeFile: async (fileName, content) => {
        if (isWithin(stagingDirectory, fileName) && path.basename(fileName) !== "manifest.json") {
          return stagingWrites.observe(
            () => nodeAsyncMaterializationHost.writeFile(fileName, content)
          );
        }
        await nodeAsyncMaterializationHost.writeFile(fileName, content);
      },
      replaceFile: async (stagedFileName, targetFileName) => {
        commitActive++;
        maximumCommitActive = Math.max(maximumCommitActive, commitActive);
        commitTargets.push(targetFileName);
        try {
          await Promise.resolve();
          await nodeAsyncMaterializationHost.replaceFile(stagedFileName, targetFileName);
        } finally {
          commitActive--;
        }
      }
    };

    try {
      const result = await runRsglMaterializationTransaction({
        files,
        outputRoot,
        project,
        transactionId: "parallel-io"
      }, host);

      assert.strictEqual(result.status, "committed");
      assert.deepStrictEqual(result.changedPaths, files.map(file => file.outputPath));
      assert.strictEqual(copyReads.calls, fileCount);
      assert.deepStrictEqual(copyReads.maximumActiveByBatch, [8]);
      assert.strictEqual(manifestReads.calls, otherManifestCount * 3);
      assert.deepStrictEqual(manifestReads.maximumActiveByBatch, [8, 8, 8]);
      assert.strictEqual(outputReads.calls, fileCount * 3);
      assert.deepStrictEqual(outputReads.maximumActiveByBatch, [8, 8, 1]);
      assert.strictEqual(stagingDirectories.calls, outputParentCount + 1);
      assert.deepStrictEqual(stagingDirectories.maximumActiveByBatch, [8]);
      assert.strictEqual(stagingWrites.calls, fileCount);
      assert.deepStrictEqual(stagingWrites.maximumActiveByBatch, [8]);
      assert.strictEqual(commitDirectories.length, outputParentCount + 1);
      assert.strictEqual(new Set(commitDirectories).size, commitDirectories.length);
      assert.strictEqual(commitTargets.length, fileCount + 1);
      assert.strictEqual(maximumCommitActive, 1);
      assert.strictEqual(
        commitTargets.at(-1),
        path.join(outputRoot, ...rsglOwnershipManifestPath(project.projectId).split("/"))
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the prepared payload index without repeated array scans", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-payload-index-");
    const project = materializationProject("payload-index-project", "payload-index-pack");
    const files = Array.from({ length: 24 }, (_, index): RsglEmittedFile => ({
      outputPath: `assets/demo/models/item/indexed-${String(index).padStart(2, "0")}.json`,
      content: `{"index":${index}}\n`,
      kind: "resource"
    }));
    const arrayPrototype = Array.prototype as unknown as FindPrototype;
    const originalFind = arrayPrototype.find;
    let preparedPayloadFindCalls = 0;
    arrayPrototype.find = function (this: unknown[], predicate, thisArg): unknown {
      if (isPreparedPayloadArray(this)) {
        preparedPayloadFindCalls++;
      }
      return originalFind.call(this, predicate, thisArg);
    };

    try {
      const asyncResult = await runRsglMaterializationTransaction({
        files,
        outputRoot: path.join(root, "async-pack"),
        project,
        transactionId: "payload-index-async"
      }, nodeAsyncMaterializationHost);
      const syncResult = runRsglMaterializationTransactionSync({
        files,
        outputRoot: path.join(root, "sync-pack"),
        project,
        transactionId: "payload-index-sync"
      });

      assert.strictEqual(asyncResult.status, "committed");
      assert.strictEqual(syncResult.status, "committed");
      assert.strictEqual(preparedPayloadFindCalls, 0);
    } finally {
      arrayPrototype.find = originalFind;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops staging dispatch after failure and waits for in-flight writes", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-staging-failure-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("staging-failure-project", "staging-failure-pack");
    const files = Array.from({ length: 16 }, (_, index): RsglEmittedFile => ({
      outputPath: `assets/demo/models/item/failure-${String(index).padStart(2, "0")}.json`,
      content: `{"index":${index}}\n`,
      kind: "resource"
    }));
    const stagingDirectory = path.join(outputRoot, ".rsgl", "staging");
    const eightWritesStarted = deferred<void>();
    const finishInFlight = deferred<void>();
    let stagedOutputWrites = 0;
    let completedInFlightWrites = 0;
    let stagedManifestWrites = 0;
    let transactionSettled = false;
    const host: RsglAsyncMaterializationHost = {
      ...nodeAsyncMaterializationHost,
      writeFile: async (fileName, content) => {
        if (!isWithin(stagingDirectory, fileName)) {
          return nodeAsyncMaterializationHost.writeFile(fileName, content);
        }
        if (path.basename(fileName) === "manifest.json") {
          stagedManifestWrites++;
          return nodeAsyncMaterializationHost.writeFile(fileName, content);
        }
        stagedOutputWrites++;
        if (stagedOutputWrites === 8) {
          eightWritesStarted.resolve();
        }
        if (stagedOutputWrites === 1) {
          await eightWritesStarted.promise;
          throw new Error("expected staging failure");
        }
        await finishInFlight.promise;
        await nodeAsyncMaterializationHost.writeFile(fileName, content);
        completedInFlightWrites++;
      }
    };

    try {
      const resultPromise = runRsglMaterializationTransaction({
        files,
        outputRoot,
        project,
        transactionId: "staging-failure"
      }, host);
      void resultPromise.then(() => {
        transactionSettled = true;
      });

      await eightWritesStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      assert.strictEqual(stagedOutputWrites, 8);
      assert.strictEqual(transactionSettled, false);

      finishInFlight.resolve();
      const result = await resultPromise;
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.failure?.operation, "stage");
      assert.strictEqual(stagedOutputWrites, 8);
      assert.strictEqual(completedInFlightWrites, 7);
      assert.strictEqual(stagedManifestWrites, 0);
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "assets")), false);
    } finally {
      finishInFlight.resolve();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

class BatchedConcurrencyProbe {
  public calls = 0;
  public readonly maximumActiveByBatch: number[] = [];
  private readonly activeByBatch: number[] = [];

  public constructor(private readonly batchSize: number) {}

  public async observe<T>(operation: () => Promise<T>): Promise<T> {
    const batch = Math.floor(this.calls / this.batchSize);
    this.calls++;
    this.activeByBatch[batch] = (this.activeByBatch[batch] ?? 0) + 1;
    this.maximumActiveByBatch[batch] = Math.max(
      this.maximumActiveByBatch[batch] ?? 0,
      this.activeByBatch[batch]
    );
    try {
      await Promise.resolve();
      return await operation();
    } finally {
      this.activeByBatch[batch]--;
    }
  }
}

interface FindPrototype {
  find(
    this: unknown[],
    predicate: (value: unknown, index: number, values: unknown[]) => unknown,
    thisArg?: unknown
  ): unknown;
}

function isPreparedPayloadArray(values: readonly unknown[]): boolean {
  const first = values[0];
  return first !== null
    && typeof first === "object"
    && "file" in first
    && "content" in first
    && "contentHash" in first
    && "absolutePath" in first;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function materializationProject(
  projectId: string,
  outputPackRootIdentity: string
): RsglMaterializationProject {
  return { projectId, sourceRoot: "rsgl", outputPackRootIdentity };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
