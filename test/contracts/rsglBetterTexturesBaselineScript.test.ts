import * as assert from "node:assert";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

describe("Better Textures RSGL baseline script", () => {
  it("reports the ignored-fixture requirement before loading compiled modules", () => {
    const script = path.resolve("scripts", "verify-rsgl-better-textures.mjs");
    const missingFixture = path.resolve("missing fixtures", "不存在", "better textures");
    const result = spawnSync(process.execPath, [script, "--fixture", missingFixture], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes(`Better Textures fixture is required at ${missingFixture}.`));
    assert.ok(result.stderr.includes("intentionally not part of a clean checkout"));
    assert.strictEqual(result.stderr.includes("ERR_MODULE_NOT_FOUND"), false);
  });
});
