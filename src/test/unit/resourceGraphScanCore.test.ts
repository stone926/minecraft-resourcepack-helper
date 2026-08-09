import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  classifyResourceGraphPaths,
  collectResourceGraphPathsInRoot,
  resourceGraphConfiguredRootMaxDepth,
  type ResourceGraphDirectoryEntry
} from "../../utils/resourceGraphScanCore";
import { collectResourceGraphWorkspacePathSnapshot } from "../../utils/resourceGraphScan";

describe("resource graph scan core", () => {
  it("collects workspace and configured paths through a narrow host", async () => {
    const workspaceModel = path.resolve("workspace", "assets", "minecraft", "models", "block", "stone.json");
    const workspaceBlockstate = path.resolve("workspace", "assets", "minecraft", "blockstates", "stone.json");
    const configuredRoot = path.resolve("configured", "assets");
    const configuredModel = path.join(configuredRoot, "minecraft", "models", "item", "stick.json");
    const entries = new Map<string, ResourceGraphDirectoryEntry[]>([
      [configuredRoot, [directory("minecraft")]],
      [path.join(configuredRoot, "minecraft"), [directory("models")]],
      [path.join(configuredRoot, "minecraft", "models"), [directory("item")]],
      [path.join(configuredRoot, "minecraft", "models", "item"), [file("stick.json")]]
    ]);

    const snapshot = await collectResourceGraphWorkspacePathSnapshot({
      findWorkspaceResourcePaths: async () => [workspaceModel, workspaceBlockstate],
      getConfiguredAssetsRoots: async () => [configuredRoot],
      getDirectoryEntries: async directoryName => entries.get(directoryName) ?? null
    });

    assert.deepStrictEqual(snapshot.modelDocumentPaths, [workspaceModel, configuredModel]);
    assert.deepStrictEqual(snapshot.blockstatePaths, [workspaceBlockstate]);
  });

  it("classifies one file snapshot for references, models, and blockstates", () => {
    const files = [
      path.join("pack", "assets", "minecraft", "models", "block", "stone.json"),
      path.join("pack", "assets", "minecraft", "blockstates", "stone.json"),
      path.join("pack", "assets", "minecraft", "textures", "block", "stone.png")
    ];

    const snapshot = classifyResourceGraphPaths(files, { includeBlockstates: true });

    assert.deepStrictEqual(snapshot.resourceReferencePaths, files.slice(0, 2));
    assert.deepStrictEqual(snapshot.modelDocumentPaths, files.slice(0, 1));
    assert.deepStrictEqual(snapshot.blockstatePaths, files.slice(1, 2));
  });

  it("reuses one bounded directory walk for all configured-root graph categories", async () => {
    const root = path.resolve("configured-pack", "assets");
    const directories = new Map<string, ResourceGraphDirectoryEntry[]>([
      [root, [directory("minecraft"), directory("ignored")]],
      [path.join(root, "minecraft"), [directory("models"), directory("blockstates")]],
      [path.join(root, "minecraft", "models"), [file("root.json")]],
      [path.join(root, "minecraft", "blockstates"), [file("stone.json")]],
      [path.join(root, "ignored"), [file("readme.txt")]]
    ]);
    const reads: string[] = [];

    const snapshot = await collectResourceGraphPathsInRoot(root, async directoryName => {
      reads.push(directoryName);
      return directories.get(directoryName) ?? null;
    }, { includeBlockstates: true, maxDepth: 2 });

    assert.deepStrictEqual(snapshot.modelDocumentPaths, [
      path.join(root, "minecraft", "models", "root.json")
    ]);
    assert.deepStrictEqual(snapshot.blockstatePaths, [path.join(root, "minecraft", "blockstates", "stone.json")]);
    assert.strictEqual(new Set(reads).size, reads.length, "each directory should be read at most once");
  });

  it("does not recurse beyond the explicit configured-root depth limit", async () => {
    const root = path.resolve("bounded-assets");
    const visited: string[] = [];

    await collectResourceGraphPathsInRoot(root, async directoryName => {
      visited.push(directoryName);
      const relative = path.relative(root, directoryName);
      const depth = relative === "" ? 0 : relative.split(path.sep).length;
      return [depth <= resourceGraphConfiguredRootMaxDepth ? directory(`level-${depth + 1}`) : file("too-deep.json")];
    });

    assert.strictEqual(visited.length, resourceGraphConfiguredRootMaxDepth + 1);
  });
});

function directory(name: string): ResourceGraphDirectoryEntry {
  return { name, isDirectory: () => true, isFile: () => false };
}

function file(name: string): ResourceGraphDirectoryEntry {
  return { name, isDirectory: () => false, isFile: () => true };
}
