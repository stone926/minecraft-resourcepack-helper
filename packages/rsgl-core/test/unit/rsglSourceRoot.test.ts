import * as assert from "node:assert";
import * as path from "node:path";
import { discoverRsglSourceRootsFromFileNames, resolveRsglSourceRootFromFileName, RsglWorkspaceSourceRootCache } from "../../src/sourceRoot";

describe("RSGL source root discovery", () => {
  it("resolves an RSGL source root from active file paths", () => {
    const sourceRoot = path.resolve("pack", "src");
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.join(sourceRoot, "main.rsgl")),
      sourceRoot
    );
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.join(sourceRoot, "nested", "blocks.rsgl")),
      sourceRoot
    );
    assert.strictEqual(
      resolveRsglSourceRootFromFileName(path.resolve("pack", "rsgl", "blocks.rsgl")),
      path.resolve("pack", "rsgl")
    );

    assert.deepStrictEqual(
      discoverRsglSourceRootsFromFileNames([
        path.join(sourceRoot, "main.rsgl"),
        path.join(sourceRoot, "nested", "blocks.rsgl"),
        path.resolve("pack", ".vscode", "ignored.rsgl"),
        path.resolve("pack", "assets", "model.json"),
        path.resolve("other_pack", "src", "main.rsgl")
      ]).map(root => root.sourceRoot),
      [
        path.resolve("other_pack", "src"),
        sourceRoot
      ].sort()
    );
  });

  it("caches RSGL workspace source root discovery until RSGL files change", async () => {
    const sourceRoot = path.resolve("pack", "src");
    const cache = new RsglWorkspaceSourceRootCache();
    let calls = 0;
    const provider = () => {
      calls++;
      return [
        path.join(sourceRoot, "main.rsgl"),
        path.join(sourceRoot, "nested", "blocks.rsgl")
      ];
    };

    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 1);

    cache.invalidatePath(path.resolve("pack", "assets", "models", "block", "stone.json"));
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 1);

    cache.invalidatePath(path.join(sourceRoot, "new.rsgl"));
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [sourceRoot]);
    assert.strictEqual(calls, 2);
  });
});
