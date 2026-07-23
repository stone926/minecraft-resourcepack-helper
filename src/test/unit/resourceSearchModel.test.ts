import * as assert from "node:assert";
import {
  searchResourceInventory,
  type ResourceSearchInventoryEntry
} from "../../services/resourceSearchModel";

describe("resource search model", () => {
  const inventory = [
    entry("model", "minecraft:block/oak_leaves", "generated"),
    entry("blockstate", "minecraft:oak_leaves", "generated"),
    entry("texture", "minecraft:block/oak_leaves", "physical"),
    entry("model", "demo:block/石灯", "physical")
  ];

  it("searches canonical ids and filters resource kinds", () => {
    const matches = searchResourceInventory(inventory, {
      query: "oak_leaves",
      kinds: ["model", "blockstate"],
      limit: 20
    });

    assert.deepStrictEqual(matches.map(match => match.kind), ["blockstate", "model"]);
  });

  it("matches normalized non-ASCII paths", () => {
    const matches = searchResourceInventory(inventory, {
      query: "石灯",
      kinds: ["model"],
      limit: 20
    });

    assert.strictEqual(matches[0]?.id, "demo:block/石灯");
  });

  it("requires a query and respects the result limit", () => {
    assert.deepStrictEqual(searchResourceInventory(inventory, {
      query: "",
      kinds: ["model", "blockstate", "texture"],
      limit: 20
    }), []);
    assert.strictEqual(searchResourceInventory(inventory, {
      query: "oak",
      kinds: ["model", "blockstate", "texture"],
      limit: 1
    }).length, 1);
  });
});

function entry(
  kind: "model" | "blockstate" | "texture",
  id: string,
  origin: "generated" | "physical"
): ResourceSearchInventoryEntry {
  const target = { kind, id };
  return {
    target,
    producer: {
      producerId: `${origin}:${kind}:${id}`,
      providerId: origin === "generated" ? "rsgl" : "physical",
      projectId: "project",
      layerId: "local",
      layerRole: "local",
      origin,
      logicalKeys: [target],
      sourceOrigins: origin === "generated"
        ? [{ uri: "file:///pack/rsgl/main.rsgl", origin: "generated" }]
        : [],
      physicalOrigins: origin === "physical"
        ? [{ uri: `file:///pack/assets/demo/${kind}/${id}`, origin: "physical" }]
        : [],
      materializationState: origin === "generated" ? "current" : "handwritten",
      outputPath: `assets/demo/${kind}/${id}`,
      revision: "r1"
    },
    resolutionStatus: "resolved",
    navigation: {
      kind: "producer",
      producerId: `${origin}:${kind}:${id}`,
      target
    }
  };
}
