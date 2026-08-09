import * as assert from "node:assert/strict";
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

      const readyCallbacks: string[] = [];
      const warmedPromise = citResourceIdService.warmResourceIds(citFileName, {}, {
        key: "test-ready",
        onReady: () => { readyCallbacks.push("superseded"); }
      });
      const sharedWarmup = citResourceIdService.warmResourceIds(citFileName, {}, {
        key: "test-ready",
        onReady: () => { readyCallbacks.push("ready"); }
      });

      assert.strictEqual(sharedWarmup, warmedPromise);
      assert.deepStrictEqual(readyCallbacks, []);
      assert.strictEqual(citResourceIdService.getCachedResourceIds(citFileName), null);

      await warmedPromise;
      assert.deepStrictEqual(readyCallbacks, ["ready"]);
      assert.strictEqual(citResourceIdService.getCachedResourceIds(citFileName)?.items.includes("custom:wand"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("shares one resource inventory across many CIT documents in the same pack", () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/custom/items/wand.json", {});
      const inventories = new Set<object>();
      for (let index = 0; index < 65; index++) {
        const relativePath = `assets/minecraft/citresewn/cit/item-${index}.properties`;
        writeFile(pack, relativePath, "type=item\n");
        inventories.add(citResourceIdService.getResourceIds(path.join(pack, relativePath)));
      }

      assert.strictEqual(inventories.size, 1);
      assert.strictEqual(
        (inventories.values().next().value as { items: string[] }).items.includes("custom:wand"),
        true
      );
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

    assert.ok(diagnosticsSource.includes("getResourceIdsForHotPath"));
    assert.strictEqual(diagnosticsSource.includes("getCachedResourceIds"), false);
    assert.strictEqual(diagnosticsSource.includes("warmResourceIds"), false);
    assert.strictEqual(diagnosticsSource.includes("getResourceIds(document.fileName"), false);
    assert.ok(completionSource.includes("getResourceIdsForHotPath"));
    assert.strictEqual(completionSource.includes("pendingCompletionRefreshes"), false);
    assert.strictEqual(completionSource.includes("getCachedResourceIds"), false);
    assert.strictEqual(completionSource.includes("warmResourceIds"), false);
    assert.strictEqual(completionSource.includes("getResourceIds(document.fileName"), false);
  });

  it("loads builtin IDs and armor classification rules from the catalog", () => {
    const builtins = citResourceIdService.getBuiltinResourceIds();

    assert.ok(builtins.items.includes("minecraft:stick"));
    assert.ok(builtins.enchantments.includes("minecraft:sharpness"));
    assert.strictEqual(citResourceIdService.isArmorItem("chainmail_helmet"), true);
    assert.strictEqual(citResourceIdService.isArmorItem("minecraft:turtle_helmet"), true);
    assert.strictEqual(citResourceIdService.isArmorItem("custom:ceremonial_boots"), true);
    assert.strictEqual(citResourceIdService.isArmorItem("minecraft:elytra"), false);
    assert.strictEqual(citResourceIdService.isArmorItem("minecraft:stick"), false);
  });
});
