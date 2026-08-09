import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

describe("cold activation sampling", () => {
  it("uses a stable median for odd and even process samples", async () => {
    const verifier = await import(pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "verify-build-budgets.mjs"
    )).href) as { medianOf(values: number[]): number };

    assert.strictEqual(verifier.medianOf([90, 10, 30]), 30);
    assert.strictEqual(verifier.medianOf([100, 10, 30, 20]), 25);
    assert.throws(() => verifier.medianOf([]), /at least one finite sample/);
    assert.throws(() => verifier.medianOf([1, Number.NaN]), /at least one finite sample/);
  });
});
