import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CitResourceIdService,
  citResourceIdService
} from "../../cit/citResourceIdService";
import { citResourceIdInventoryWatcherPattern } from "../../cit/citResourceIdInventory";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { createPack, createTempDirectory, removeTempDirectory, writeFile, writeJson } from "./helpers/tempPack";

describe("CIT resource ID service", () => {
  beforeEach(() => {
    workspaceResourceCache.invalidateAll();
    citResourceIdService.invalidateAll();
  });

  afterEach(() => {
    workspaceResourceCache.invalidateAll();
    citResourceIdService.invalidateAll();
  });

  it("refreshes item IDs after resource JSON files are created", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      const itemFileName = path.join(pack, "assets", "custom", "items", "wand.json");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");

      const before = await citResourceIdService.getResourceIds(citFileName);
      assert.strictEqual(before.items.includes("custom:wand"), false);

      writeJson(pack, "assets/custom/items/wand.json", {});
      workspaceResourceCache.invalidatePath(itemFileName);
      citResourceIdService.invalidatePath(itemFileName, "create");

      const after = await citResourceIdService.getResourceIds(citFileName);
      assert.strictEqual(after.items.includes("custom:wand"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("keeps filename inventories warm across content and unrelated resource changes", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      const itemFileName = path.join(pack, "assets", "custom", "items", "wand.json");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");
      writeJson(pack, "assets/custom/items/wand.json", {});

      const initial = await citResourceIdService.getResourceIds(citFileName);
      citResourceIdService.invalidatePath(itemFileName, "change");
      citResourceIdService.invalidatePath(
        path.join(pack, "assets", "custom", "textures", "item", "wand.png"),
        "create"
      );

      assert.strictEqual(await citResourceIdService.getResourceIds(citFileName), initial);

      const secondItem = path.join(pack, "assets", "custom", "items", "staff.json");
      writeJson(pack, "assets/custom/items/staff.json", {});
      workspaceResourceCache.invalidatePath(secondItem);
      citResourceIdService.invalidatePath(secondItem, "create");
      const refreshed = await citResourceIdService.getResourceIds(citFileName);
      assert.notStrictEqual(refreshed, initial);
      assert.ok(refreshed.items.includes("custom:staff"));
    } finally {
      removeTempDirectory(root);
    }
  });

  it("refreshes custom enchantment IDs on data inventory create and delete events", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(
        pack,
        "assets",
        "minecraft",
        "citresewn",
        "cit",
        "wand.properties"
      );
      const enchantmentFileName = path.join(
        pack,
        "data",
        "arcana",
        "enchantment",
        "stormcall.json"
      );
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=elytra\n");

      assert.strictEqual(
        (await citResourceIdService.getResourceIds(citFileName)).enchantments.includes("arcana:stormcall"),
        false
      );

      writeJson(pack, "data/arcana/enchantment/stormcall.json", {});
      workspaceResourceCache.invalidatePath(enchantmentFileName);
      citResourceIdService.invalidatePath(enchantmentFileName, "create");
      assert.strictEqual(
        (await citResourceIdService.getResourceIds(citFileName)).enchantments.includes("arcana:stormcall"),
        true
      );

      fs.rmSync(enchantmentFileName);
      workspaceResourceCache.invalidatePath(enchantmentFileName);
      citResourceIdService.invalidatePath(enchantmentFileName, "delete");
      assert.strictEqual(
        (await citResourceIdService.getResourceIds(citFileName)).enchantments.includes("arcana:stormcall"),
        false
      );
    } finally {
      removeTempDirectory(root);
    }
  });

  it("declares one dedicated watcher for singular and plural enchantment inventories", () => {
    assert.strictEqual(
      citResourceIdInventoryWatcherPattern,
      "**/data/*/{enchantment,enchantments}/**"
    );
  });

  it("eventually revalidates inventories when recursive watcher coverage is unavailable", async () => {
    const root = createTempDirectory();
    let now = 0;

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      const itemFileName = path.join(pack, "assets", "custom", "items", "late.json");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");
      const service = new CitResourceIdService(() => ({
        schemaVersion: 1,
        defaultNamespace: "minecraft",
        items: [],
        enchantments: [],
        armorSuffixes: []
      }), {
        now: () => now,
        inventoryFreshnessTtlMs: 100
      });

      assert.strictEqual((await service.getResourceIds(citFileName)).items.includes("custom:late"), false);
      writeJson(pack, "assets/custom/items/late.json", {});
      workspaceResourceCache.invalidatePath(itemFileName);
      now = 99;
      assert.strictEqual((await service.getResourceIds(citFileName)).items.includes("custom:late"), false);
      now = 100;
      assert.strictEqual((await service.getResourceIds(citFileName)).items.includes("custom:late"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("keeps a stale inventory visible while a TTL refresh runs", async () => {
    const root = createTempDirectory();
    let now = 0;

    try {
      const pack = createPack(root, "pack");
      const citFileName = path.join(pack, "assets", "minecraft", "citresewn", "cit", "wand.properties");
      writeFile(pack, "assets/minecraft/citresewn/cit/wand.properties", "type=item\n");
      writeJson(pack, "assets/custom/items/existing.json", {});
      const service = new CitResourceIdService(() => ({
        schemaVersion: 1,
        defaultNamespace: "minecraft",
        items: [],
        enchantments: [],
        armorSuffixes: []
      }), {
        now: () => now,
        inventoryFreshnessTtlMs: 100
      });

      assert.deepStrictEqual((await service.getResourceIds(citFileName)).items, ["custom:existing"]);
      writeJson(pack, "assets/custom/items/late.json", {});
      // Simulate the filesystem cache independently observing the change while
      // the inventory watcher misses it; only the inventory TTL should expire.
      workspaceResourceCache.invalidatePath(path.join(pack, "assets", "custom", "items", "late.json"));
      now = 100;

      let readyCount = 0;
      const stale = service.getResourceIdsForHotPath(citFileName, {}, {
        key: "ttl-refresh",
        onReady: () => { readyCount++; }
      });
      assert.deepStrictEqual(stale.items, ["custom:existing"]);

      const refreshed = await service.warmResourceIds(citFileName);
      assert.deepStrictEqual(refreshed.items, ["custom:existing", "custom:late"]);
      assert.strictEqual(readyCount, 1);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("warms resource IDs with asynchronous filesystem traversal without blocking the caller", async () => {
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

      const serviceSource = fs.readFileSync(
        path.join(process.cwd(), "src", "cit", "citResourceIdService.ts"),
        "utf8"
      );
      assert.ok(serviceSource.includes("await fs.readdir"));
      assert.strictEqual(serviceSource.includes("resolve(this.getResourceIds"), false);

      await warmedPromise;
      assert.deepStrictEqual(readyCallbacks, ["ready"]);
      assert.strictEqual(citResourceIdService.getCachedResourceIds(citFileName)?.items.includes("custom:wand"), true);
    } finally {
      removeTempDirectory(root);
    }
  });

  it("shares one resource inventory across many CIT documents in the same pack", async () => {
    const root = createTempDirectory();

    try {
      const pack = createPack(root, "pack");
      writeJson(pack, "assets/custom/items/wand.json", {});
      const inventories = new Set<object>();
      for (let index = 0; index < 65; index++) {
        const relativePath = `assets/minecraft/citresewn/cit/item-${index}.properties`;
        writeFile(pack, relativePath, "type=item\n");
        inventories.add(await citResourceIdService.getResourceIds(path.join(pack, relativePath)));
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
