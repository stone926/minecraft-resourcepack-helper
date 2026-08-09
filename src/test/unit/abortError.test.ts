import * as assert from "node:assert/strict";
import { isAbortError } from "../../utils/abortError";

describe("abort error classification", () => {
  it("recognizes native, structural, and wrapped abort errors", () => {
    const abort = new Error("superseded");
    abort.name = "AbortError";

    assert.strictEqual(isAbortError(abort), true);
    assert.strictEqual(isAbortError({ name: "AbortError" }), true);
    assert.strictEqual(isAbortError(new Error("wrapper", { cause: abort })), true);
  });

  it("rejects ordinary errors and terminates on cyclic causes", () => {
    const cyclic: { name: string; cause?: unknown } = { name: "Error" };
    cyclic.cause = cyclic;

    assert.strictEqual(isAbortError(new Error("failure")), false);
    assert.strictEqual(isAbortError(cyclic), false);
    assert.strictEqual(isAbortError(null), false);
  });
});
