import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  assertTestProcessStatus,
  defaultTestProcessMochaTimeoutMs,
  runTestProcessSync
} from "../helpers/testProcess";

describe("model preview benchmark script", function () {
  this.timeout(defaultTestProcessMochaTimeoutMs);

  it("loads the compiled preview service and emits every benchmark fixture", () => {
    const root = process.cwd();
    const result = runTestProcessSync(
      process.execPath,
      [path.join(root, "scripts", "model-preview-benchmark.mjs")],
      { cwd: root }
    );

    assertTestProcessStatus(result);
    assert.strictEqual(result.stderr, "");
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines[0], "fixture,first_ir_ms,hot_refresh_ms");
    assert.deepStrictEqual(
      lines.slice(1, 5).map(line => line.split(",", 1)[0]),
      ["simple", "parent-chain-8", "elements-500", "generated-texture-alpha"]
    );
    assert.strictEqual(lines[5], "artifact,raw_bytes,gzip_bytes");
    const [artifact, rawBytes, gzipBytes] = lines[6].split(",");
    assert.strictEqual(artifact, "model-preview-production");
    assert.ok(Number(rawBytes) > 0);
    assert.ok(Number(gzipBytes) > 0);
    assert.ok(Number(gzipBytes) < Number(rawBytes));
  });
});
