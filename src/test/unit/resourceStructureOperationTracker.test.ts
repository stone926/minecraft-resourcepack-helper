import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  ResourceStructureOperationTracker,
  type ResourceStructureOperationFileSystem
} from "../../services/resourceStructureOperationTracker";

describe("resource structure operation tracker", () => {
  it("refreshes resource directories without broad invalidation for leaf or unrelated files", async () => {
    const packRoot = path.resolve("workspace", "pack");
    const modelsDirectory = path.join(packRoot, "assets", "minecraft", "models");
    const modelFile = path.join(modelsDirectory, "block", "stone.json");
    const unrelatedDirectory = path.resolve("workspace", "src");
    const directories = new Set([packRoot, modelsDirectory, unrelatedDirectory]);
    const existing = new Set([path.join(packRoot, "pack.mcmeta")]);
    const tracker = new ResourceStructureOperationTracker({
      fileSystem: fakeFileSystem(directories, existing)
    });

    assert.strictEqual(await tracker.consumeAfter([modelFile]), false);
    assert.strictEqual(await tracker.consumeAfter([unrelatedDirectory]), false);
    assert.strictEqual(await tracker.consumeAfter([modelsDirectory]), true);
    assert.strictEqual(await tracker.consumeAfter([packRoot]), true);
  });

  it("remembers a resource directory across delete and rename completion", async () => {
    const directory = path.resolve("workspace", "pack", "assets", "minecraft", "models", "foo.json");
    const directories = new Set([directory]);
    const tracker = new ResourceStructureOperationTracker({
      fileSystem: fakeFileSystem(directories, new Set())
    });

    tracker.rememberBefore([directory]);
    directories.delete(directory);

    assert.strictEqual(await tracker.consumeAfter([directory]), true);
    assert.strictEqual(await tracker.consumeAfter([directory]), false);
  });

  it("tracks a folded grouping-directory operation containing a nested pack", async () => {
    const groupingDirectory = path.resolve("workspace", "packs");
    const nestedMetadata = path.join(groupingDirectory, "pack-a", "pack.mcmeta");
    const directories = new Set([groupingDirectory]);
    const existing = new Set([nestedMetadata]);
    let now = 0;
    let descendantProbes = 0;
    const tracker = new ResourceStructureOperationTracker({
      fileSystem: fakeFileSystem(directories, existing),
      resourceDescendantExists: async directory => {
        descendantProbes++;
        return directory === groupingDirectory && existing.has(nestedMetadata);
      },
      now: () => now
    });

    assert.strictEqual(await tracker.consumeAfter([groupingDirectory]), true);
    assert.strictEqual(descendantProbes, 1);
    tracker.rememberBefore([groupingDirectory]);
    directories.clear();
    existing.clear();
    now = 60_000;

    assert.strictEqual(await tracker.consumeAfter([groupingDirectory]), true);
    assert.strictEqual(descendantProbes, 1);
  });
});

function fakeFileSystem(
  directories: ReadonlySet<string>,
  existing: ReadonlySet<string>
): ResourceStructureOperationFileSystem {
  return {
    isDirectory: fileName => directories.has(fileName),
    pathExists: fileName => directories.has(fileName) || existing.has(fileName)
  };
}
