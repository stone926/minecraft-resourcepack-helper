import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { isRsglPathInsideOrEqual } from "../../src/pathIdentity";

describe("RSGL path containment", () => {
  it("accepts dot-dot-prefixed names without accepting parent traversal", () => {
    const root = path.join(os.tmpdir(), "rsgl-path-containment");

    assert.strictEqual(isRsglPathInsideOrEqual(root, root), true);
    assert.strictEqual(
      isRsglPathInsideOrEqual(path.join(root, "..foo", "main.rsgl"), root),
      true
    );
    assert.strictEqual(
      isRsglPathInsideOrEqual(path.join(root, "nested", "main.rsgl"), root),
      true
    );
    assert.strictEqual(
      isRsglPathInsideOrEqual(path.resolve(root, "..", "outside.rsgl"), root),
      false
    );
  });
});
