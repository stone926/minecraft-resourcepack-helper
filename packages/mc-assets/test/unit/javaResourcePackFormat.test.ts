import * as assert from "node:assert/strict";
import {
  currentJavaResourcePackFormat,
  currentMinecraftJavaVersion,
  isMinecraftJavaVersionText,
  javaResourcePackFormatForMinecraftVersion,
  legacyJavaResourcePackFormatBoundary,
  legacyResourcePackFormatBoundaryMinecraftVersion
} from "../../src";

describe("Java resource-pack format registry", () => {
  it("maps stable Java releases from the canonical compatibility table", () => {
    assert.deepStrictEqual(javaResourcePackFormatForMinecraftVersion("26.2"), {
      major: 88,
      minor: 0
    });
    assert.deepStrictEqual(javaResourcePackFormatForMinecraftVersion("1.20.3"), {
      major: 22,
      minor: 0
    });
    assert.deepStrictEqual(javaResourcePackFormatForMinecraftVersion("1.19.2"), {
      major: 9,
      minor: 0
    });
  });

  it("derives the current and legacy-boundary formats from the release registry", () => {
    assert.deepStrictEqual(
      currentJavaResourcePackFormat,
      javaResourcePackFormatForMinecraftVersion(currentMinecraftJavaVersion)
    );
    assert.strictEqual(
      legacyJavaResourcePackFormatBoundary,
      javaResourcePackFormatForMinecraftVersion(legacyResourcePackFormatBoundaryMinecraftVersion)?.major
    );
  });

  it("validates version syntax and never exposes a mutable registry entry", () => {
    assert.strictEqual(isMinecraftJavaVersionText("1.21.4"), true);
    assert.strictEqual(isMinecraftJavaVersionText("latest"), false);
    assert.strictEqual(javaResourcePackFormatForMinecraftVersion("1.99.0"), null);

    const resolved = javaResourcePackFormatForMinecraftVersion("1.21.4");
    assert.ok(resolved);
    resolved.major = 1;
    assert.deepStrictEqual(javaResourcePackFormatForMinecraftVersion("1.21.4"), {
      major: 46,
      minor: 0
    });
  });
});
