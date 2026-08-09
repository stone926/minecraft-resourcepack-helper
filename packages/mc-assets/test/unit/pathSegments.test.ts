import * as assert from "node:assert/strict";
import { startsWithPathSegment } from "../../src";

describe("path segment helpers", () => {
  it("matches a complete first segment across separator styles", () => {
    assert.strictEqual(startsWithPathSegment("assets/minecraft/models", "assets"), true);
    assert.strictEqual(startsWithPathSegment("Assets\\minecraft\\models", "assets"), true);
    assert.strictEqual(startsWithPathSegment("assets", "ASSETS"), true);
    assert.strictEqual(startsWithPathSegment("assets-extra/models", "assets"), false);
    assert.strictEqual(startsWithPathSegment("./assets/models", "assets"), false);
    assert.strictEqual(startsWithPathSegment("/assets/models", "assets"), false);
  });
});
