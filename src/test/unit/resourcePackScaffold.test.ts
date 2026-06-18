import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNamespaceFolders, resourcePackNamespaceDirectories, writePackScaffold } from "../../commands/resourcePackScaffold";

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
      assert.strictEqual(fs.statSync(path.join(packPath, "assets", "custom", "waypoint_style")).isDirectory(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-"));
}
