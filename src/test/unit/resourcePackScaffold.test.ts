import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultPackAttributes, getPackMcmeta, isPackFormatVersion } from "../../commands/constants";
import { createNamespaceFolders, resourcePackNamespaceDirectories, writePackScaffold } from "../../commands/resourcePackScaffold";
import { createTempDirectory } from "./helpers/tempPack";

describe("resource pack scaffold", () => {
  it("creates current Java resource pack namespace directories", () => {
    const root = createTempDirectory();

    try {
      createNamespaceFolders(root, "example");

      for (const resourcePath of resourcePackNamespaceDirectories) {
        assert.strictEqual(
          fs.statSync(path.join(root, "assets", "example", resourcePath)).isDirectory(),
          true,
          resourcePath
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes modern pack metadata and the namespace scaffold", () => {
    const root = createTempDirectory();
    const packPath = path.join(root, "pack");

    try {
      writePackScaffold(packPath, "custom", "86.2", "test pack");

      const metadata = JSON.parse(fs.readFileSync(path.join(packPath, "pack.mcmeta"), "utf8"));
      assert.deepStrictEqual(metadata.pack.min_format, [86, 2]);
      assert.deepStrictEqual(metadata.pack.max_format, [86, 2]);
      assert.strictEqual(metadata.pack.description, "test pack");
      assert.strictEqual(fs.statSync(path.join(packPath, "pack.png")).isFile(), true);
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "items")).isDirectory(), true);
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "post_effect")).isDirectory(), true);
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "sounds")).isDirectory(), true);
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "textures", "effect")).isDirectory(), true);
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "waypoint_style")).isDirectory(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the current manual resource pack format as the scaffold default", () => {
    assert.strictEqual(defaultPackAttributes.packFormat, "88.0");
  });

  it("serializes modern pack.mcmeta metadata safely", () => {
    const result = JSON.parse(getPackMcmeta("86.2", 'quote " and slash \\'));

    assert.deepStrictEqual(result.pack.min_format, [86, 2]);
    assert.deepStrictEqual(result.pack.max_format, [86, 2]);
    assert.strictEqual(result.pack.description, 'quote " and slash \\');
  });

  it("accepts integer and decimal pack format inputs", () => {
    assert.strictEqual(isPackFormatVersion("69"), true);
    assert.strictEqual(isPackFormatVersion("86.2"), true);
    assert.strictEqual(isPackFormatVersion("0"), false);
    assert.strictEqual(isPackFormatVersion("86.x"), false);
  });
});

