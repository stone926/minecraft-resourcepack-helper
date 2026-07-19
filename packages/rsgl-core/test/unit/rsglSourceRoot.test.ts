import * as assert from "node:assert";
import * as path from "node:path";
import {
  discoverRsglSourceRootsFromFileNames,
  resolveRsglNavigationSourceRoot,
  resolveRsglSourceRootFromFileName,
  RsglWorkspaceSourceRootCache
} from "../../src/sourceRoot";

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
    const cache = new RsglWorkspaceSourceRootCache({ pathExists: () => true });
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

  it("uses configured and project boundaries for reverse-import navigation", () => {
    const projectRoot = path.resolve("pack with spaces");
    const customRoot = path.join(projectRoot, "source files");
    const nestedFile = path.join(customRoot, "lib", "definition.rsgl");

    assert.strictEqual(
      resolveRsglNavigationSourceRoot(nestedFile, { configuredRoot: customRoot }),
      customRoot
    );
    assert.strictEqual(
      resolveRsglNavigationSourceRoot(nestedFile, { projectRoots: [projectRoot] }),
      projectRoot
    );

    const conventionalRoot = path.join(projectRoot, "src");
    assert.strictEqual(
      resolveRsglNavigationSourceRoot(path.join(conventionalRoot, "lib", "definition.rsgl"), {
        projectRoots: [projectRoot]
      }),
      conventionalRoot
    );

    const nestedProjectRoot = path.join(conventionalRoot, "嵌套 project");
    assert.strictEqual(
      resolveRsglNavigationSourceRoot(path.join(nestedProjectRoot, "lib", "definition.rsgl"), {
        projectRoots: [projectRoot, nestedProjectRoot]
      }),
      nestedProjectRoot,
      "a nearest config project must not inherit an outer conventional src boundary"
    );

    const workspaceRoot = path.resolve("工作区", "no-src pack");
    assert.strictEqual(
      resolveRsglNavigationSourceRoot(path.join(workspaceRoot, "lib", "definition.rsgl"), {
        projectRoots: [workspaceRoot]
      }),
      workspaceRoot,
      "an initialized workspace is the safe reverse-import boundary when src/config are absent"
    );
  });

  it("does not cache a workspace scan that was invalidated while in flight", async () => {
    const cache = new RsglWorkspaceSourceRootCache({ pathExists: () => true });
    const firstRoot = path.resolve("first", "src");
    const secondRoot = path.resolve("second", "src");
    let releaseFirst!: (files: string[]) => void;
    let calls = 0;
    const provider = () => {
      calls++;
      if (calls === 1) {
        return new Promise<string[]>(resolve => {
          releaseFirst = resolve;
        });
      }
      return [path.join(secondRoot, "main.rsgl")];
    };

    const discovery = cache.discover(provider);
    cache.invalidatePath(path.join(secondRoot, "main.rsgl"));
    releaseFirst([path.join(firstRoot, "main.rsgl")]);

    assert.deepStrictEqual((await discovery).map(root => root.sourceRoot), [secondRoot]);
    assert.strictEqual(calls, 2);
  });

  it("rechecks missing samples immediately and discovers moved-in roots after TTL", async () => {
    const firstFile = path.resolve("first", "src", "main.rsgl");
    const secondRoot = path.resolve("second", "src");
    const secondFile = path.join(secondRoot, "main.rsgl");
    const existing = new Set([firstFile]);
    let now = 0;
    let files = [firstFile];
    let calls = 0;
    const cache = new RsglWorkspaceSourceRootCache({
      verificationTtlMs: 1_000,
      now: () => now,
      pathExists: fileName => existing.has(fileName)
    });
    const provider = () => {
      calls++;
      return files;
    };

    assert.strictEqual((await cache.discover(provider))[0]?.sampleFileName, firstFile);
    existing.delete(firstFile);
    files = [];
    assert.deepStrictEqual(await cache.discover(provider), []);
    assert.strictEqual(calls, 2, "a missing sample must bypass the unexpired cache");

    existing.add(secondFile);
    files = [secondFile];
    assert.deepStrictEqual(await cache.discover(provider), []);
    now = 1_001;
    assert.deepStrictEqual((await cache.discover(provider)).map(root => root.sourceRoot), [secondRoot]);
    assert.strictEqual(calls, 3, "a moved-in root must appear after the verification TTL");
  });
});
