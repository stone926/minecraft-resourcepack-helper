import * as assert from "node:assert";
import * as path from "node:path";
import {
  buildResourceCompletionValue,
  filterExistingResourceRoots,
  getAssetsRootCandidates,
  parsePartialResourcePath,
  shouldCompleteNamespaces
} from "../../utils/resourceCompletionPaths";

describe("resource completion paths", () => {
  it("parses namespaced nested resource paths", () => {
    assert.deepStrictEqual(parsePartialResourcePath("minecraft:block/qu"), {
      namespace: "minecraft",
      explicitNamespace: true,
      directory: "block",
      prefix: "qu"
    });
  });

  it("builds nested completion values without dropping parent directories", () => {
    const partialPath = parsePartialResourcePath("minecraft:block/qu");

    assert.strictEqual(
      buildResourceCompletionValue(partialPath, "quartz_block_smooth", false),
      "minecraft:block/quartz_block_smooth"
    );
  });

  it("builds root directory completion values after a namespace", () => {
    const partialPath = parsePartialResourcePath("minecraft:");

    assert.strictEqual(
      buildResourceCompletionValue(partialPath, "block", true),
      "minecraft:block/"
    );
  });

  it("detects namespace completion positions before a resource path starts", () => {
    assert.strictEqual(shouldCompleteNamespaces(parsePartialResourcePath("")), true);
    assert.strictEqual(shouldCompleteNamespaces(parsePartialResourcePath("mine")), true);
    assert.strictEqual(shouldCompleteNamespaces(parsePartialResourcePath("minecraft:")), false);
    assert.strictEqual(shouldCompleteNamespaces(parsePartialResourcePath("block/")), false);
  });

  it("derives assets roots from resource roots for namespace completion", () => {
    const packRoot = path.join("pack");
    const overlayRoot = path.join("pack", "overlay");

    assert.deepStrictEqual(
      getAssetsRootCandidates(
        [
          path.join(packRoot, "assets", "minecraft", "textures"),
          path.join(overlayRoot, "assets", "minecraft", "textures")
        ],
        "minecraft",
        "textures"
      ),
      [
        path.join(packRoot, "assets"),
        path.join(overlayRoot, "assets")
      ]
    );
  });

  it("filters fallback roots that do not exist before deriving namespaces", async () => {
    const defaultPackRoot = path.join("packs", "vanilla");
    const roots = [
      path.join(defaultPackRoot, "minecraft", "textures"),
      path.join(defaultPackRoot, "textures"),
      path.join(defaultPackRoot, "assets", "minecraft", "textures")
    ];

    const existingRoots = await filterExistingResourceRoots(
      roots,
      root => root === path.join(defaultPackRoot, "assets", "minecraft", "textures")
    );

    assert.deepStrictEqual(
      getAssetsRootCandidates(existingRoots, "minecraft", "textures"),
      [
        path.join(defaultPackRoot, "assets")
      ]
    );
  });
});
