import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { PackMetadata } from "../../../../packages/mc-assets/src";
import {
  ModelPreviewHostFileSystem,
  type ModelPreviewHostFileSystemDependencies
} from "../../../modelPreview/host/ModelPreviewHostFileSystem";

describe("ModelPreviewHostFileSystem", () => {
  it("prefers a matching open file document over the disk reader", async () => {
    const fileName = path.join("pack", "assets", "example", "models", "item", "tool.json");
    let diskReads = 0;
    const fileSystem = new ModelPreviewHostFileSystem(createDependencies({
      getOpenTextDocuments: () => [
        { fileName, uri: { scheme: "untitled" }, getText: () => "untitled" },
        { fileName: path.join(".", fileName), uri: { scheme: "file" }, getText: () => "open text" }
      ],
      readTextFile: async () => {
        diskReads++;
        return "disk text";
      }
    }));

    assert.strictEqual(await fileSystem.readTextFile(fileName), "open text");
    assert.strictEqual(diskReads, 0);
  });

  it("falls back to the disk reader when no open file document matches", async () => {
    const requests: string[] = [];
    const fileSystem = new ModelPreviewHostFileSystem(createDependencies({
      getOpenTextDocuments: () => [{
        fileName: path.join("other", "model.json"),
        uri: { scheme: "file" },
        getText: () => "other"
      }],
      readTextFile: async fileName => {
        requests.push(fileName);
        return "disk text";
      }
    }));

    assert.strictEqual(await fileSystem.readTextFile("target.json"), "disk text");
    assert.deepStrictEqual(requests, ["target.json"]);
  });

  it("delegates binary, cache generation, version, pack root, and metadata operations", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const metadata: PackMetadata = {
      overlays: [],
      filters: [{ namespace: "example", path: null }]
    };
    const binary = new Uint8Array([1, 2, 3]);
    const dependencies = createDependencies({
      readBinaryFile: async fileName => {
        calls.push({ name: "readBinaryFile", args: [fileName] });
        return binary;
      },
      fileExists: fileName => {
        calls.push({ name: "fileExists", args: [fileName] });
        return true;
      },
      getResourceGeneration: () => {
        calls.push({ name: "getResourceGeneration", args: [] });
        return 17;
      },
      hasAnyResourceChangedSince: (generation, fileNames) => {
        calls.push({ name: "hasAnyResourceChangedSince", args: [generation, fileNames] });
        return true;
      },
      fileVersion: fileName => {
        calls.push({ name: "fileVersion", args: [fileName] });
        return "open:5";
      },
      getPackRoot: fileName => {
        calls.push({ name: "getPackRoot", args: [fileName] });
        return "pack-root";
      },
      getPackMetadata: packRoot => {
        calls.push({ name: "getPackMetadata", args: [packRoot] });
        return metadata;
      }
    });
    const fileSystem = new ModelPreviewHostFileSystem(dependencies);
    const dependenciesToCheck = ["model.json", "texture.png"];

    assert.strictEqual(await fileSystem.readBinaryFile("texture.png"), binary);
    assert.strictEqual(fileSystem.fileExists("model.json"), true);
    assert.strictEqual(fileSystem.getResourceGeneration(), 17);
    assert.strictEqual(fileSystem.hasAnyResourceChangedSince(12, dependenciesToCheck), true);
    assert.strictEqual(fileSystem.fileVersion("model.json"), "open:5");
    assert.strictEqual(fileSystem.getPackRoot("model.json"), "pack-root");
    assert.strictEqual(fileSystem.getPackMetadata("pack-root"), metadata);
    assert.deepStrictEqual(calls, [
      { name: "readBinaryFile", args: ["texture.png"] },
      { name: "fileExists", args: ["model.json"] },
      { name: "getResourceGeneration", args: [] },
      { name: "hasAnyResourceChangedSince", args: [12, dependenciesToCheck] },
      { name: "fileVersion", args: ["model.json"] },
      { name: "getPackRoot", args: ["model.json"] },
      { name: "getPackMetadata", args: ["pack-root"] }
    ]);
  });
});

function createDependencies(
  overrides: Partial<ModelPreviewHostFileSystemDependencies> = {}
): ModelPreviewHostFileSystemDependencies {
  return {
    getOpenTextDocuments: () => [],
    readTextFile: async () => "",
    readBinaryFile: async () => new Uint8Array(),
    fileExists: () => false,
    getResourceGeneration: () => 0,
    hasAnyResourceChangedSince: () => false,
    fileVersion: () => null,
    getPackRoot: () => null,
    getPackMetadata: () => ({ overlays: [], filters: [] }),
    ...overrides
  };
}
