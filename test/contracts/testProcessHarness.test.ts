import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFreshCompiledModule } from "../helpers/compiledHarness";
import {
  assertTestProcessStatus,
  runTestProcessSync
} from "../helpers/testProcess";

describe("test process harness", () => {
  it("captures UTF-8 output and reports non-zero exits with both streams", () => {
    const result = runTestProcessSync(process.execPath, [
      "-e",
      "process.stdout.write('标准输出'); process.stderr.write('diagnostic stderr'); process.exitCode = 7;"
    ]);

    assert.strictEqual(result.stdout, "标准输出");
    assert.strictEqual(result.stderr, "diagnostic stderr");
    assert.throws(
      () => assertTestProcessStatus(result),
      error => {
        const message = String(error);
        assert.match(message, /标准输出/);
        assert.match(message, /diagnostic stderr/);
        assert.match(message, /status: 7/);
        return true;
      }
    );
  });

  it("terminates a hung process and preserves output written before the timeout", () => {
    assert.throws(
      () => runTestProcessSync(process.execPath, [
        "-e",
        "process.stdout.write('before timeout'); process.stderr.write('timeout stderr'); setInterval(() => {}, 1000);"
      ], { timeout: 200 }),
      error => {
        const message = String(error);
        assert.match(message, /ETIMEDOUT/);
        assert.match(message, /before timeout/);
        assert.match(message, /timeout stderr/);
        assert.match(message, /timeout: 200ms/);
        return true;
      }
    );
  });

  it("rejects stale compiled output before a harness can load it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcres-compiled-harness-"));
    const source = path.join(root, "src", "example.ts");
    const output = path.join(root, "out", "src", "example.js");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(source, "export const value = 1;\n", "utf8");
    fs.writeFileSync(output, "exports.value = 1;\n", "utf8");
    const old = new Date(Date.now() - 10_000);
    const recent = new Date();

    try {
      fs.utimesSync(source, old, recent);
      fs.utimesSync(output, old, old);
      assert.throws(
        () => resolveFreshCompiledModule("src/example.ts", { repositoryRoot: root }),
        /Compiled harness output is stale/
      );
      fs.utimesSync(output, recent, recent);
      assert.strictEqual(
        resolveFreshCompiledModule("src/example.ts", { repositoryRoot: root }),
        output
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
