import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface PruneModule {
  sourcePathForTypeScriptOutput(
    fileName: string,
    options: { repositoryRoot: string; outputRoot: string }
  ): string | null;
  pruneStaleTypeScriptOutputs(options: {
    repositoryRoot: string;
    outputRoot: string;
  }): { removedFiles: number; removedDirectories: number };
}

describe("stale TypeScript output pruning", () => {
  let pruning: PruneModule;

  before(async () => {
    pruning = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "prune-stale-typescript-outputs.mjs"
    )).href) as PruneModule;
  });

  it("removes orphaned compiler outputs while preserving incremental state and live outputs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-prune-outputs-"));
    const out = path.join(root, "out");
    try {
      write(root, "src/live.ts", "export const live = true;\n");
      for (const relativePath of [
        "out/src/live.js",
        "out/src/live.js.map",
        "out/src/live.d.ts",
        "out/src/stale.js",
        "out/src/stale.js.map",
        "out/src/stale.d.ts",
        "out/src/stale.d.ts.map"
      ]) {
        write(root, relativePath, "generated");
      }
      write(root, "out/.tsbuildinfo/tests.tsbuildinfo", "incremental");
      write(root, "out/packages/rsgl-core/dist/stdlib/core.rsgl", "stdlib");

      const result = pruning.pruneStaleTypeScriptOutputs({
        repositoryRoot: root,
        outputRoot: out
      });

      assert.strictEqual(result.removedFiles, 4);
      assert.strictEqual(fs.existsSync(path.join(out, "src", "stale.js")), false);
      assert.strictEqual(fs.existsSync(path.join(out, "src", "live.js")), true);
      assert.strictEqual(fs.existsSync(path.join(out, ".tsbuildinfo", "tests.tsbuildinfo")), true);
      assert.strictEqual(
        fs.existsSync(path.join(out, "packages", "rsgl-core", "dist", "stdlib", "core.rsgl")),
        true
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to map files outside the configured output root", () => {
    const root = path.join(process.cwd(), "fixture");
    const out = path.join(root, "out");
    assert.strictEqual(
      pruning.sourcePathForTypeScriptOutput(path.join(root, "elsewhere", "file.js"), {
        repositoryRoot: root,
        outputRoot: out
      }),
      null
    );
  });
});

function write(root: string, relativePath: string, content: string): void {
  const fileName = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, content, "utf8");
}
