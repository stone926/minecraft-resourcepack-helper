import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("model preview benchmark script", () => {
  it("loads the compiled preview service and emits every benchmark fixture", () => {
    const root = process.cwd();
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "model-preview-benchmark.mjs")], {
      cwd: root,
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, "");
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines[0], "fixture,first_ir_ms,hot_refresh_ms");
    assert.deepStrictEqual(
      lines.slice(1).map(line => line.split(",", 1)[0]),
      ["simple", "parent-chain-8", "elements-500", "generated-texture-alpha"]
    );
  });
});
