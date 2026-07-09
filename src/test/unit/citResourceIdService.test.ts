import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { citResourceIdService } from "../../cit/citResourceIdService";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { createPack, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "./helpers/tempPack";

describe("CIT resource ID service", () => {
  beforeEach(() => {
    workspaceResourceCache.invalidateAll();
  });

  afterEach(() => {
    workspaceResourceCache.invalidateAll();
  });

  it("refreshes item IDs after resource JSON files are created", () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      const itemFileName = path.join(pack, "assets", "custom", "items", "wand.json");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");

      const before = citResourceIdService.getResourceIds(citFileName);
      assert.strictEqual(before.items.includes("custom:wand"), false);

      writeJson(pack, "assets/custom/items/wand.json", {});
      workspaceResourceCache.invalidatePath(itemFileName);

      const after = citResourceIdService.getResourceIds(citFileName);
      assert.strictEqual(after.items.includes("custom:wand"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("warms resource IDs asynchronously without blocking the caller", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");
      writeJson(pack, "assets/custom/items/wand.json", {});

      let warmed = false;
      const warmedPromise = new Promise<void>(resolve => {
        citResourceIdService.warmResourceIds(citFileName, {}, () => {
          warmed = true;
          resolve();
        });
      });

      assert.strictEqual(warmed, false);
      assert.strictEqual(citResourceIdService.getCachedResourceIds(citFileName), null);

      await warmedPromise;
      assert.strictEqual(warmed, true);
      assert.strictEqual(citResourceIdService.getCachedResourceIds(citFileName)?.items.includes("custom:wand"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("keeps VS Code hot paths off the synchronous resource ID scan path", () => {
    const diagnosticsSource = fs.readFileSync(
      path.join(process.cwd(), "src", "cit", "citDiagnostics.ts"),
      "utf8"
    );
    const completionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "cit", "providers", "citCompletionProvider.ts"),
      "utf8"
    );

    assert.ok(diagnosticsSource.includes("getCachedResourceIds"));
    assert.ok(diagnosticsSource.includes("warmResourceIds"));
    assert.strictEqual(diagnosticsSource.includes("getResourceIds(document.fileName"), false);
    assert.ok(completionSource.includes("getCachedResourceIds"));
    assert.ok(completionSource.includes("warmResourceIds"));
    assert.strictEqual(completionSource.includes("getResourceIds(document.fileName"), false);
  });
});
