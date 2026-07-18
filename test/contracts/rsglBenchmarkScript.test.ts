import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

describe("RSGL benchmark script", () => {
  it("runs deterministic synthetic smoke scenarios and emits validated CSV metrics", () => {
    const root = process.cwd();
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "rsgl-benchmark.mjs"), "--smoke"],
      { cwd: root, encoding: "utf8" }
    );

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, "");
    const rows = result.stdout.trim().split(/\r?\n/).map(line => line.split(","));
    assert.deepStrictEqual(rows[0], [
      "scenario",
      "profile",
      "work_items",
      "input_bytes",
      "iterations",
      "outputs",
      "diagnostics",
      "source_mappings",
      "min_ms",
      "median_ms",
      "p95_ms"
    ]);
    assert.deepStrictEqual(rows.slice(1).map(row => row[0]), [
      "single-file-parse-semantic",
      "large-canonical-blockstate-compile",
      "bounded-product-budget"
    ]);
    assert.ok(rows.slice(1).every(row => row.length === rows[0].length));
    assert.ok(rows.slice(1).every(row => row[1] === "smoke" && row[4] === "1"));
    assert.deepStrictEqual(rows.slice(1).map(row => Number(row[5])), [80, 2, 0]);
    assert.deepStrictEqual(rows.slice(1).map(row => Number(row[6])), [0, 0, 1]);
    assert.ok(Number(rows[2][7]) > 120, "large blockstate should emit per-variant source mappings");
    for (const row of rows.slice(1)) {
      for (const column of [2, 3, 4, 8, 9, 10]) {
        assert.ok(Number.isFinite(Number(row[column])) && Number(row[column]) >= 0);
      }
    }
  });
});
