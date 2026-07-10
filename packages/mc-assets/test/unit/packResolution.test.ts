import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findAssetsRoot,
  findPackRoot,
  getAssetsRootPathCandidates,
  getDocumentResourceRootCandidates,
  getResourceFileCandidates,
  packRootFromAssetsPath,
  parseAssetsPath,
  parseResourceLocation,
  resolveResourceFile
} from "../../src";


describe("resource location utilities", () => {
  it("parses implicit minecraft namespace and appends extension", () => {
    const result = parseResourceLocation("block/acacia_button", "json");

    assert.strictEqual(result.namespace, "minecraft");
    assert.strictEqual(result.resourcePath, path.join("block", "acacia_button.json"));
  });

  it("parses explicit namespace without duplicating extension", () => {
    const result = parseResourceLocation("example:item/custom.png", "png");

    assert.strictEqual(result.namespace, "example");
    assert.strictEqual(result.resourcePath, path.join("item", "custom.png"));
  });

  it("parses directory resource locations without appending an extension", () => {
    const result = parseResourceLocation("minecraft:block", null);

    assert.strictEqual(result.namespace, "minecraft");
    assert.strictEqual(result.resourcePath, "block");
    assert.strictEqual(result.isValid, true);
  });

  it("rejects resource locations with parent directory traversal", () => {
    const result = parseResourceLocation("example:../../outside", "json");

    assert.strictEqual(result.namespace, "example");
    assert.strictEqual(result.isValid, false);
  });

  it("rejects resource locations with characters outside Java identifier rules", () => {
    assert.strictEqual(parseResourceLocation("Example:block/stone", "json").isValid, false);
    assert.strictEqual(parseResourceLocation("example:block/Stone", "json").isValid, false);
    assert.strictEqual(parseResourceLocation("example:block:name", "json").isValid, false);
    assert.strictEqual(parseResourceLocation("example:block stone", "json").isValid, false);
  });

  it("normalizes repeated separators through shared resource id rules", () => {
    const result = parseResourceLocation("example:block//stone", "json");

    assert.strictEqual(result.namespace, "example");
    assert.strictEqual(result.resourcePath, path.join("block", "stone.json"));
    assert.strictEqual(result.isValid, true);
  });

  it("finds assets root from nested source folders", () => {
    const root = path.parse(__dirname).root;
    const fileName = path.join(root, "pack", "assets", "minecraft", "models", "block", "cube.json");
    const result = findAssetsRoot(fileName, "models/block");

    assert.strictEqual(result, path.join(root, "pack", "assets"));
  });

  it("finds assets root from namespace-root source files", () => {
    const root = path.parse(__dirname).root;
    const fileName = path.join(root, "pack", "assets", "minecraft", "sounds.json");
    const result = findAssetsRoot(fileName, "sounds.json");

    assert.strictEqual(result, path.join(root, "pack", "assets"));
  });

  it("uses the base pack assets as fallback for overlay resources", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(path.join(packRoot, "overlays", "newer", "assets", "minecraft", "models", "block"), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");

      const fileName = path.join(packRoot, "overlays", "newer", "assets", "minecraft", "models", "block", "cube.json");
      const roots = getDocumentResourceRootCandidates(fileName, "models/block", null, "minecraft", "textures");

      assert.deepStrictEqual(roots, [
        path.join(packRoot, "overlays", "newer", "assets", "minecraft", "textures"),
        path.join(packRoot, "assets", "minecraft", "textures")
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate the base pack assets for normal pack resources", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(path.join(packRoot, "assets", "minecraft", "models", "block"), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");

      const fileName = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
      const roots = getDocumentResourceRootCandidates(fileName, "models/block", null, "minecraft", "textures");

      assert.deepStrictEqual(roots, [
        path.join(packRoot, "assets", "minecraft", "textures")
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("orders active overlays above the base pack with later entries first", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");

    try {
      fs.mkdirSync(path.join(packRoot, "assets", "minecraft", "models", "custom"), { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), JSON.stringify({
        pack: {
          ["min_format"]: [88, 0],
          ["max_format"]: [88, 0],
          description: "test"
        },
        overlays: {
          entries: [
            {
              directory: "old_overlay",
              ["min_format"]: [88, 0],
              ["max_format"]: [88, 0]
            },
            {
              directory: "new_overlay",
              ["min_format"]: [88, 0],
              ["max_format"]: [88, 0]
            }
          ]
        }
      }));

      const fileName = path.join(packRoot, "assets", "minecraft", "models", "custom", "machine.json");
      const roots = getDocumentResourceRootCandidates(fileName, "models", null, "minecraft", "textures");

      assert.deepStrictEqual(roots, [
        path.join(packRoot, "new_overlay", "assets", "minecraft", "textures"),
        path.join(packRoot, "old_overlay", "assets", "minecraft", "textures"),
        path.join(packRoot, "assets", "minecraft", "textures")
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use default assets when the current pack filter blocks the resource", () => {
    const root = createTempDirectory();
    const packRoot = path.join(root, "pack");
    const defaultAssets = path.join(root, "default_assets");

    try {
      fs.mkdirSync(path.join(packRoot, "assets", "minecraft", "models", "block"), { recursive: true });
      fs.mkdirSync(defaultAssets, { recursive: true });
      fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), JSON.stringify({
        pack: {
          ["min_format"]: [88, 0],
          ["max_format"]: [88, 0],
          description: "test"
        },
        filter: {
          block: [
            {
              namespace: "minecraft",
              path: "textures/block/stone.*"
            }
          ]
        }
      }));

      const fileName = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
      const roots = getDocumentResourceRootCandidates(fileName, "models/block", defaultAssets, "minecraft", "textures", {
        resourcePath: "textures/block/stone.png"
      });

      assert.deepStrictEqual(roots, [
        path.join(packRoot, "assets", "minecraft", "textures")
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses configured lower-priority resource packs before default assets", () => {
    const root = createTempDirectory();
    const currentPack = path.join(root, "current");
    const lowerPack = path.join(root, "lower");
    const defaultAssets = path.join(root, "default_assets");

    try {
      fs.mkdirSync(path.join(currentPack, "assets", "minecraft", "models", "block"), { recursive: true });
      fs.mkdirSync(path.join(lowerPack, "assets", "minecraft", "textures"), { recursive: true });
      fs.mkdirSync(defaultAssets, { recursive: true });
      for (const packRoot of [currentPack, lowerPack]) {
        fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), JSON.stringify({
          pack: {
            ["min_format"]: [88, 0],
            ["max_format"]: [88, 0],
            description: "test"
          }
        }));
      }

      const fileName = path.join(currentPack, "assets", "minecraft", "models", "block", "cube.json");
      const roots = getDocumentResourceRootCandidates(fileName, "models/block", defaultAssets, "minecraft", "textures", {
        resourcePath: "textures/block/stone.png",
        resourcePackRoots: [lowerPack]
      });

      assert.deepStrictEqual(roots, [
        path.join(currentPack, "assets", "minecraft", "textures"),
        path.join(lowerPack, "assets", "minecraft", "textures"),
        path.join(defaultAssets, "minecraft", "textures"),
        path.join(defaultAssets, "textures"),
        path.join(defaultAssets, "assets", "minecraft", "textures")
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses assets paths into assets root, namespace, and relative segments", () => {
    const parsed = parseAssetsPath(path.join("pack", "assets", "minecraft", "textures", "block", "stone.png"));

    assert.deepStrictEqual(parsed, {
      assetsRoot: path.join("pack", "assets"),
      namespace: "minecraft",
      relativeSegments: ["textures", "block", "stone.png"]
    });
  });

  it("uses the innermost lowercase assets directory", () => {
    const nested = parseAssetsPath(path.join("outer", "assets", "a", "assets", "ns", "file.png"));

    assert.deepStrictEqual(nested, {
      assetsRoot: path.join("outer", "assets", "a", "assets"),
      namespace: "ns",
      relativeSegments: ["file.png"]
    });
  });

  it("resolves identical candidates through basic and cached hosts", () => {
    const root = createTempDirectory();
    const currentPack = path.join(root, "current pack 资源");
    const lowerPack = path.join(root, "lower pack 后备");
    const defaultAssets = path.join(root, "default assets 默认");
    const sourceFileName = path.join(currentPack, "assets", "minecraft", "models", "block", "cube.json");
    const lowerTexture = path.join(lowerPack, "assets", "minecraft", "textures", "block", "stone.png");
    const defaultTexture = path.join(defaultAssets, "minecraft", "textures", "block", "stone.png");

    try {
      for (const fileName of [sourceFileName, lowerTexture, defaultTexture]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, "");
      }
      for (const packRoot of [currentPack, lowerPack]) {
        fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      }

      const request = {
        resourcePath: "minecraft:block/stone",
        sourceFileName,
        target: "textures",
        source: "models/block",
        targetFileExtension: "png",
        defaultAssetsPath: defaultAssets,
        resourcePackRoots: [lowerPack]
      };
      const basicHost = { pathExists: (fileName: string) => fs.existsSync(fileName) };
      const basicCandidates = getResourceFileCandidates(request, basicHost);
      const basicResolution = resolveResourceFile(request, basicHost);
      const cachedResolution = resolveResourceFile(request, {
        ...basicHost,
        getResourceLocation: parseResourceLocation,
        getRootCandidates: (resourceRequest, normalizedResourcePath, namespace) =>
          getDocumentResourceRootCandidates(
            resourceRequest.sourceFileName,
            resourceRequest.source,
            resourceRequest.defaultAssetsPath,
            namespace,
            resourceRequest.target,
            {
              pathExists: basicHost.pathExists,
              resourcePackRoots: resourceRequest.resourcePackRoots,
              resourcePath: normalizedResourcePath
            }
          )
      });

      assert.deepStrictEqual(cachedResolution.candidates, basicCandidates);
      assert.strictEqual(basicResolution.fileName, lowerTexture);
      assert.strictEqual(cachedResolution.fileName, lowerTexture);
      assert.ok(basicCandidates.indexOf(lowerTexture) < basicCandidates.indexOf(defaultTexture));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects uppercase Assets directories", () => {
    assert.strictEqual(parseAssetsPath(path.join("pack", "Assets", "custom", "sounds.json")), null);
    assert.strictEqual(packRootFromAssetsPath(path.join("pack", "Assets", "custom", "sounds.json")), null);
  });

  it("returns null for paths without an assets namespace", () => {
    assert.strictEqual(parseAssetsPath(path.join("pack", "data", "recipes", "stone.json")), null);
    assert.strictEqual(parseAssetsPath(path.join("pack", "assets")), null);
    assert.deepStrictEqual(parseAssetsPath(path.join("pack", "assets", "minecraft"))?.relativeSegments, []);
  });

  it("derives pack roots from assets paths without touching the filesystem", () => {
    assert.strictEqual(
      packRootFromAssetsPath(path.join("packs", "example", "assets", "minecraft", "models", "block", "cube.json")),
      path.join("packs", "example")
    );
    assert.strictEqual(packRootFromAssetsPath(path.join("packs", "example", "models", "cube.json")), null);
  });

  it("normalizes configured paths to lowercase assets root candidates", () => {
    assert.deepStrictEqual(
      getAssetsRootPathCandidates(path.join("packs", "example")),
      [path.join("packs", "example", "assets")]
    );
    assert.deepStrictEqual(
      getAssetsRootPathCandidates(path.join("packs", "example", "assets", "minecraft")),
      [path.join("packs", "example", "assets"), path.join("packs", "example", "assets", "minecraft", "assets")]
    );
    assert.deepStrictEqual(
      getAssetsRootPathCandidates(path.join("packs", "example", "Assets")),
      [path.join("packs", "example", "Assets", "assets")]
    );
  });

  it("finds pack roots upward from a file, checking the stopAt directory itself", () => {
    const root = path.parse(__dirname).root;
    const packRoot = path.join(root, "packs", "example");
    const fileName = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
    const pathExists = (filePath: string) => filePath === path.join(packRoot, "pack.mcmeta");

    assert.strictEqual(findPackRoot(fileName, { pathExists }), packRoot);
    assert.strictEqual(findPackRoot(fileName, { pathExists, stopAt: packRoot }), packRoot);
  });

  it("does not search above the stopAt directory for pack.mcmeta", () => {
    const root = path.parse(__dirname).root;
    const packRoot = path.join(root, "packs", "example");
    const fileName = path.join(packRoot, "assets", "minecraft", "models", "block", "cube.json");
    const pathExists = (filePath: string) => filePath === path.join(root, "packs", "pack.mcmeta");

    assert.strictEqual(findPackRoot(fileName, { pathExists }), path.join(root, "packs"));
    assert.strictEqual(findPackRoot(fileName, { pathExists, stopAt: packRoot }), null);
  });
});

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-"));
}
