import * as assert from "node:assert/strict";
import * as path from "node:path";
import { observeCitAssetCandidates } from "../../../modelPreview/resolve/CitAssetCandidateObserver";

describe("model preview CIT candidate observation", () => {
  it("observes pack metadata and every asset candidate through one helper", () => {
    const root = path.parse(__dirname).root;
    const packRoot = path.join(root, "packs", "example");
    const sourceFileName = path.join(
      packRoot,
      "assets",
      "custom",
      "citresewn",
      "cit",
      "tools",
      "hammer.properties"
    );
    const configuredRoot = path.join(root, "packs", "fallback");
    const observed: string[] = [];

    const candidates = observeCitAssetCandidates(sourceFileName, "./alternate", "models", {
      fileSystem: {
        readTextFile: async () => "",
        readBinaryFile: async () => new Uint8Array(),
        fileExists: () => false,
        getPackRoot: () => packRoot
      },
      configuration: { resourcePackRoots: [configuredRoot] },
      observeDependency: fileName => observed.push(fileName)
    });

    assert.ok(observed.includes(path.join(packRoot, "pack.mcmeta")));
    assert.ok(observed.includes(path.join(configuredRoot, "pack.mcmeta")));
    assert.ok(candidates.length > 0);
    assert.deepStrictEqual(observed.slice(-candidates.length), candidates);
  });
});
