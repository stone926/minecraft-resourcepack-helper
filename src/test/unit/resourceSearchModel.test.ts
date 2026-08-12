import * as assert from "node:assert/strict";
import {
  prepareResourceSearchInventory,
  resourceSearchQueryKey,
  searchPreparedResourceInventory,
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

  it("prepares normalized search fields once for repeated queries", () => {
    const indexed = entry("model", "demo:block/Stone_Lamp", "physical");
    let outputPathReads = 0;
    Object.defineProperty(indexed.producer, "outputPath", {
      enumerable: true,
      get: () => {
        outputPathReads++;
        return "assets/demo/models/block/Stone_Lamp.json";
      }
    });

    const prepared = prepareResourceSearchInventory([indexed]);
    const readsAfterPreparation = outputPathReads;
    assert.ok(readsAfterPreparation > 0);

    assert.strictEqual(searchPreparedResourceInventory(prepared, {
      query: "stone",
      kinds: ["model"],
      limit: 20
    }).length, 1);
    assert.strictEqual(searchPreparedResourceInventory(prepared, {
      query: "assets/demo",
      kinds: ["model"],
      limit: 20
    }).length, 1);
    assert.strictEqual(
      outputPathReads,
      readsAfterPreparation,
      "prepared searches should not reread or renormalize producer paths"
    );
  });

  it("keeps query-time work linear and returns the same ranked top results", () => {
    const large = Array.from({ length: 1_000 }, (_, index) => entry(
      index % 3 === 0 ? "blockstate" : index % 3 === 1 ? "model" : "texture",
      `demo:block/stone_${String(999 - index).padStart(4, "0")}`,
      "physical"
    ));
    const prepared = prepareResourceSearchInventory(large);
    let idReads = 0;
    for (const kind of ["blockstate", "model", "texture"] as const) {
      for (const preparedEntry of prepared.byKind[kind]) {
        const id = preparedEntry.match.id;
        Object.defineProperty(preparedEntry.match, "id", {
          configurable: true,
          enumerable: true,
          get: () => {
            idReads++;
            return id;
          }
        });
      }
    }

    const matches = searchPreparedResourceInventory(prepared, {
      query: "stone",
      kinds: ["model", "blockstate", "texture"],
      limit: 25
    });

    assert.strictEqual(idReads, 0, "queries should not compare and sort every matching id");
    assert.strictEqual(matches.length, 25);
    assert.ok(matches.every(match => match.kind === "blockstate"));
    assert.deepStrictEqual(
      matches.map(match => match.id),
      [...matches.map(match => match.id)].sort((left, right) => left.localeCompare(right, "en"))
    );
  });

  it("keeps owner candidates on prepared matches", () => {
    const indexed = entry("model", "demo:block/conflicted", "generated");
    const alternative = entry("model", "demo:block/conflicted", "physical").producer;
    indexed.candidates = [indexed.producer, alternative];

    const [match] = searchPreparedResourceInventory(
      prepareResourceSearchInventory([indexed]),
      { query: "conflicted", kinds: ["model"], limit: 20 }
    );

    assert.deepStrictEqual(match.candidates, [indexed.producer, alternative]);
  });

  it("canonicalizes equivalent query keys", () => {
    assert.strictEqual(
      resourceSearchQueryKey({
        query: " ＳＴＯＮＥ ",
        kinds: ["texture", "model", "model"],
        limit: 20.9
      }),
      resourceSearchQueryKey({
        query: "stone",
        kinds: ["model", "texture"],
        limit: 20
      })
    );
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
