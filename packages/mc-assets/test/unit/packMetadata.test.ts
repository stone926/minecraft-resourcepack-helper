import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  overlayApplies,
  parsePackMetadata,
  readPackMetadata,
  resourceMatchesFilters,
  selectActiveOverlays
} from "../../src";

describe("pack metadata", () => {
  it("parses modern overlay format bounds and resource filters in source order", () => {
    const metadata = parsePackMetadata({
      overlays: {
        entries: [
          { directory: "base_88", min_format: 88, max_format: 88 },
          { directory: "exact", min_format: [88, 0], max_format: [88, 0] }
        ]
      },
      filter: {
        block: [
          { namespace: "minecraft", path: "textures/block/stone.*" },
          { namespace: "example" },
          { path: "models/item/.*" },
          {}
        ]
      }
    });

    assert.deepStrictEqual(metadata, {
      overlays: [
        {
          directory: "base_88",
          minFormat: { major: 88, minor: 0 },
          maxFormat: { major: 88, minor: Number.MAX_SAFE_INTEGER },
          legacyFormats: null
        },
        {
          directory: "exact",
          minFormat: { major: 88, minor: 0 },
          maxFormat: { major: 88, minor: 0 },
          legacyFormats: null
        }
      ],
      filters: [
        { namespace: "minecraft", path: "textures/block/stone.*" },
        { namespace: "example", path: null },
        { namespace: null, path: "models/item/.*" },
        { namespace: null, path: null }
      ]
    });
    assert.strictEqual(metadata.overlays.every(entry => overlayApplies(entry)), true);
  });

  it("parses supported legacy ranges and rejects reversed or non-positive ranges", () => {
    const metadata = parsePackMetadata({
      overlays: {
        entries: [
          { directory: "single", formats: 64 },
          { directory: "tuple", formats: [60, 64] },
          { directory: "object", formats: { min_inclusive: 63, max_inclusive: 65 } },
          { directory: "reversed_tuple", formats: [64, 60] },
          { directory: "zero_object", formats: { min_inclusive: 0, max_inclusive: 64 } }
        ]
      }
    });

    assert.deepStrictEqual(metadata.overlays.map(entry => entry.legacyFormats), [
      { min: 64, max: 64 },
      { min: 60, max: 64 },
      { min: 63, max: 65 },
      null,
      null
    ]);
    assert.deepStrictEqual(
      metadata.overlays.map(entry => overlayApplies(entry)),
      [false, false, false, false, false],
      "legacy formats must be evaluated against the current target instead of a fixed 64 boundary"
    );
    assert.deepStrictEqual(
      metadata.overlays.map(entry => overlayApplies(entry, { major: 64, minor: 0 })),
      [true, true, true, false, false]
    );
  });

  it("selects overlays from the target format or an explicit context override", () => {
    const overlays = parsePackMetadata({
      overlays: {
        entries: [
          { directory: "legacy", formats: [60, 64] },
          { directory: "minor_1", min_format: [88, 1], max_format: [88, 1] },
          { directory: "current", min_format: [88, 0], max_format: [88, 0] }
        ]
      }
    }).overlays;

    assert.deepStrictEqual(selectActiveOverlays(overlays, {
      targetPackFormat: { major: 64, minor: 0 }
    }).map(entry => entry.directory), ["legacy"]);
    assert.deepStrictEqual(selectActiveOverlays(overlays, {
      targetPackFormat: { major: 88, minor: 1 }
    }).map(entry => entry.directory), ["minor_1"]);
    assert.deepStrictEqual(selectActiveOverlays(overlays, {
      targetPackFormat: { major: 88, minor: 0 },
      overlaySelection: ["minor_1", "unknown"]
    }).map(entry => entry.directory), ["minor_1"]);
  });

  it("ignores malformed overlay and filter entries while preserving a valid match-all object", () => {
    const metadata = parsePackMetadata({
      overlays: {
        entries: [
          null,
          { directory: "UPPERCASE" },
          { directory: "nested/path" },
          { directory: "valid-name_2", min_format: [88, 0], max_format: [88, 0] }
        ]
      },
      filter: {
        block: [null, "minecraft", 42, [], {}, { namespace: "minecraft", path: 12 }]
      }
    });

    assert.deepStrictEqual(metadata.overlays.map(entry => entry.directory), ["valid-name_2"]);
    assert.deepStrictEqual(metadata.filters, [
      { namespace: null, path: null },
      { namespace: "minecraft", path: null }
    ]);
  });

  it("matches optional regex dimensions, normalizes separators, and contains invalid regexes", () => {
    assert.strictEqual(resourceMatchesFilters(
      [{ namespace: "minecraft", path: "textures/block/stone(?:\\.png)?" }],
      "minecraft",
      "textures\\block\\stone.png"
    ), true);
    assert.strictEqual(resourceMatchesFilters(
      [{ namespace: "example", path: null }],
      "example",
      "models/item/tool.json"
    ), true);
    assert.strictEqual(resourceMatchesFilters(
      [{ namespace: null, path: "models/item/.*" }],
      "another",
      "models/item/tool.json"
    ), true);
    assert.strictEqual(resourceMatchesFilters(
      [{ namespace: "[", path: ".*" }, { namespace: ".*", path: "[" }],
      "minecraft",
      "models/item/tool.json"
    ), false);
    assert.strictEqual(resourceMatchesFilters([{ namespace: null, path: null }], "minecraft", undefined), false);
  });

  it("reads pack.mcmeta and safely falls back for missing or malformed files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-assets-pack-metadata-"));
    try {
      fs.writeFileSync(path.join(root, "pack.mcmeta"), JSON.stringify({
        overlays: { entries: [{ directory: "format_88", min_format: 88, max_format: 88 }] }
      }));
      assert.deepStrictEqual(readPackMetadata(root).overlays.map(entry => entry.directory), ["format_88"]);

      fs.writeFileSync(path.join(root, "pack.mcmeta"), "not json");
      assert.deepStrictEqual(readPackMetadata(root), { overlays: [], filters: [] });

      let pathChecked = "";
      assert.deepStrictEqual(readPackMetadata(root, {
        pathExists: fileName => {
          pathChecked = fileName;
          return false;
        }
      }), { overlays: [], filters: [] });
      assert.strictEqual(pathChecked, path.join(root, "pack.mcmeta"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
