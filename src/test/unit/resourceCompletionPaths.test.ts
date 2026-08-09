import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  buildResourceCompletionText,
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

  it("uses full explicit namespace completion text for VS Code filtering", () => {
    const partialPath = parsePartialResourcePath("minecraft:");

    assert.deepStrictEqual(
      buildResourceCompletionText(partialPath, "block", true),
      {
        value: "minecraft:block/",
        filterText: "minecraft:block/"
      }
    );
  });

  it("uses full nested explicit namespace completion text for VS Code filtering", () => {
    const partialPath = parsePartialResourcePath("minecraft:block/cu");

    assert.deepStrictEqual(
      buildResourceCompletionText(partialPath, "cut_copper", false),
      {
        value: "minecraft:block/cut_copper",
        filterText: "minecraft:block/cut_copper"
      }
    );
  });

  it("keeps implicit minecraft completion text relative to the namespace root", () => {
    assert.deepStrictEqual(
      buildResourceCompletionText(parsePartialResourcePath(""), "block", true),
      {
        value: "block/",
        filterText: "block/"
      }
    );
    assert.deepStrictEqual(
      buildResourceCompletionText(parsePartialResourcePath("block/cu"), "cut_copper", false),
      {
        value: "block/cut_copper",
        filterText: "block/cut_copper"
      }
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

  it("does not derive namespace roots from non-assets fallback roots", () => {
    const packRoot = path.join("packs", "vanilla");

    assert.deepStrictEqual(
      getAssetsRootCandidates(
        [
          path.join(packRoot, "minecraft", "textures"),
          path.join(packRoot, "textures"),
          path.join(packRoot, "assets", "minecraft", "textures")
        ],
        "minecraft",
        "textures"
      ),
      [
        path.join(packRoot, "assets")
      ]
    );
  });
});
