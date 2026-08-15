import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SafeCitResourceWriter } from "../../cit/services/safeCitResourceWriter";
import { createPack, createTempDirectory, removeTempDirectory } from "./helpers/tempPack";

describe("safe CIT resource writer", () => {
  it("creates a new asset exclusively inside the pack", async () => {
    const root = createTempDirectory();

    try {
      const packRoot = createPack(root, "pack");
      const targetPath = path.join(packRoot, "assets", "demo", "textures", "item", "new.png");
      const plan = { packRoot, targetPath, content: new Uint8Array([1, 2, 3]) };
      const writer = new SafeCitResourceWriter();

      await writer.create(plan);
      assert.deepStrictEqual([...fs.readFileSync(targetPath)], [1, 2, 3]);
      await assert.rejects(writer.create(plan), (error: unknown) =>
        !!error && typeof error === "object" && "code" in error
          && (error as { code?: unknown }).code === "EEXIST"
      );
    } finally {
      removeTempDirectory(root);
    }
  });

  it("rejects an existing symlink or junction that redirects the target outside the pack", async () => {
    const root = createTempDirectory();

    try {
      const packRoot = createPack(root, "pack");
      const outside = path.join(root, "outside");
      const link = path.join(packRoot, "assets", "demo", "textures");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const targetPath = path.join(link, "escaped.png");

      await assert.rejects(
        new SafeCitResourceWriter().create({
          packRoot,
          targetPath,
          content: new Uint8Array([9])
        }),
        /escapes its resource pack/
      );
      assert.strictEqual(fs.existsSync(path.join(outside, "escaped.png")), false);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("rejects a dangling final symlink before an exclusive Windows write can follow it", async function () {
    const root = createTempDirectory();

    try {
      const packRoot = createPack(root, "pack");
      const targetPath = path.join(packRoot, "assets", "demo", "textures", "escaped.png");
      const outsideTarget = path.join(root, "outside", "escaped.png");
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.mkdirSync(path.dirname(outsideTarget), { recursive: true });
      try {
        fs.symlinkSync(outsideTarget, targetPath, "file");
      } catch (error) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          this.skip();
          return;
        }
        throw error;
      }

      await assert.rejects(
        new SafeCitResourceWriter().create({
          packRoot,
          targetPath,
          content: new Uint8Array([7, 8, 9])
        }),
        (error: unknown) => !!error
          && typeof error === "object"
          && "code" in error
          && (error as { code?: unknown }).code === "EEXIST"
      );
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
      removeTempDirectory(root);
    }
  });
});

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return process.platform === "win32"
    && !!error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "EPERM";
}
