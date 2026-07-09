import * as assert from "node:assert";
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
});
