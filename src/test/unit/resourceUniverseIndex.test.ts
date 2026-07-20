import * as assert from "node:assert";
import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import {
  ResourceUniverseIndex,
  type ProviderCoverage,
  type ResourceEdge,
  type ResourceProducer,
  type ResourceProviderSnapshot,
  type ResourceResolutionContext
} from "../../resourceUniverse/core";

describe("resource universe index", () => {
  const modelKey: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/target" };
  const textureKey: ResourceGraphLogicalKey = { kind: "texture", id: "demo:block/stone" };

  it("atomically replaces one provider/project contribution and rejects stale generations", () => {
    const index = new ResourceUniverseIndex();
    const first = producer("physical", "handwritten", modelKey, "local");
    assert.strictEqual(index.replaceSnapshot(snapshot("physical", 1, [first], [edge(first, textureKey)])), true);
    assert.deepStrictEqual(index.getProducersForKey(modelKey).map(item => item.producerId), [first.producerId]);
    assert.strictEqual(index.getIncoming(textureKey).length, 1);

    const replacementKey: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/replacement" };
    const replacement = producer("physical", "handwritten", replacementKey, "local");
    assert.strictEqual(index.replaceSnapshot(snapshot("physical", 2, [replacement], [])), true);
    assert.deepStrictEqual(index.getProducersForKey(modelKey), []);
    assert.strictEqual(index.getIncoming(textureKey).length, 0);
    assert.deepStrictEqual(index.getProducersForKey(replacementKey).map(item => item.producerId), [replacement.producerId]);

    assert.strictEqual(index.replaceSnapshot(snapshot("physical", 1, [first], [])), false);
    assert.deepStrictEqual(index.getProducersForKey(replacementKey).map(item => item.producerId), [replacement.producerId]);
  });

  it("indexes concrete keys, aliases, aggregates, outgoing edges, and incoming targets separately", () => {
    const index = new ResourceUniverseIndex();
    const texture = {
      ...producer("physical", "handwritten", textureKey, "local"),
      aliasKeys: [{ kind: "texture", id: "demo:block/stone.png" }],
      aggregateMemberships: [{ kind: "textureDirectory", id: "demo:block" }]
    } satisfies ResourceProducer;
    const outgoing = edge(texture, modelKey);
    index.replaceSnapshot(snapshot("physical", 1, [texture], [outgoing]));

    assert.deepStrictEqual(
      index.getProducersForKey({ kind: "texture", id: "demo:block/stone.png" }).map(item => item.producerId),
      [texture.producerId]
    );
    assert.deepStrictEqual(
      index.getAggregateMembers({ kind: "textureDirectory", id: "demo:block" }).map(item => item.producerId),
      [texture.producerId]
    );
    assert.deepStrictEqual(index.getOutgoing(texture.producerId).map(item => item.edgeId), [outgoing.edgeId]);
    assert.deepStrictEqual(index.getIncoming(modelKey).map(item => item.edgeId), [outgoing.edgeId]);
  });

  it("only returns deterministic missing when every applicable provider has complete coverage", () => {
    const index = new ResourceUniverseIndex();
    index.replaceSnapshot(snapshot("physical", 1, [], [], authoritative("physical-r1")));
    index.replaceSnapshot(snapshot("rsgl", 1, [], [], {
      status: "unavailable",
      reason: "loading"
    }));
    const context = resolutionContext("effective", ["local-layer"], ["physical", "rsgl"]);

    assert.deepStrictEqual(index.resolve(modelKey, context), {
      status: "incomplete",
      target: modelKey,
      candidates: [],
      coverageComplete: false,
      unavailableProviderIds: ["rsgl"]
    });

    index.replaceSnapshot(snapshot("rsgl", 2, [], [], authoritative("rsgl-r1")));
    assert.deepStrictEqual(index.resolve(modelKey, context), {
      status: "missing",
      target: modelKey,
      candidates: [],
      coverageComplete: true,
      unavailableProviderIds: []
    });
  });

  it("projects partial coverage per target instead of treating it as empty or globally complete", () => {
    const index = new ResourceUniverseIndex();
    index.replaceSnapshot(snapshot("rsgl", 1, [], [], {
      status: "partial",
      revision: "r1",
      authoritativeScopes: [{
        projectId: "project",
        resolutionScopes: ["effective"],
        kinds: ["model"],
        namespaces: ["demo"],
        pathPrefixes: ["block"]
      }],
      unavailableScopes: [{ projectId: "project", kinds: ["texture"] }],
      skippedSourceUris: ["file:///workspace/rsgl/broken.rsgl"]
    }));
    const context = resolutionContext("effective", ["local-layer"], ["rsgl"]);

    assert.strictEqual(index.resolve(modelKey, context).status, "missing");
    assert.deepStrictEqual(index.resolve(textureKey, context), {
      status: "incomplete",
      target: textureKey,
      candidates: [],
      coverageComplete: false,
      unavailableProviderIds: ["rsgl"]
    });
  });

  it("preserves last-known facts while provider coverage is unavailable or partial", () => {
    const index = new ResourceUniverseIndex();
    const first = producer("rsgl", "unbuilt", modelKey, "local", "generated");
    index.replaceSnapshot(snapshot("rsgl", 1, [first], [], authoritative("r1")));

    index.replaceSnapshot(snapshot("rsgl", 2, [], [], {
      status: "unavailable",
      reason: "lspFailed",
      lastKnownRevision: "r1"
    }));
    assert.deepStrictEqual(index.getProducersForKey(modelKey).map(item => item.producerId), [first.producerId]);

    const secondKey: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/second" };
    const second = producer("rsgl", "unbuilt", secondKey, "local", "generated");
    index.replaceSnapshot(snapshot("rsgl", 3, [second], [], {
      status: "partial",
      revision: "r2",
      authoritativeScopes: [{ projectId: "project", pathPrefixes: ["block/second"] }],
      unavailableScopes: [{ projectId: "project", pathPrefixes: ["block/target"] }],
      skippedSourceUris: ["file:///workspace/rsgl/first.rsgl"]
    }));
    assert.deepStrictEqual(index.getProducersForKey(modelKey).map(item => item.producerId), [first.producerId]);
    assert.deepStrictEqual(index.getProducersForKey(secondKey).map(item => item.producerId), [second.producerId]);

    index.replaceSnapshot(snapshot("rsgl", 4, [second], [], authoritative("r3")));
    assert.deepStrictEqual(index.getProducersForKey(modelKey), []);
  });

  it("keeps local extern resolution restricted to handwritten physical producers", () => {
    const index = new ResourceUniverseIndex();
    const handwritten = producer("physical", "handwritten", modelKey, "local");
    const generated = producer("rsgl", "current", modelKey, "local", "generated");
    index.replaceSnapshot(snapshot("physical", 1, [handwritten], [], authoritative("physical-r1")));
    index.replaceSnapshot(snapshot("rsgl", 1, [generated], [], authoritative("rsgl-r1")));

    const result = index.resolve(
      modelKey,
      resolutionContext("local", ["local-layer"], ["physical", "rsgl"])
    );
    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.status === "resolved" ? result.winner.producerId : "", handwritten.producerId);
    assert.deepStrictEqual(result.candidates.map(item => item.producer.producerId), [handwritten.producerId]);
  });

  it("reports a same-layer planned output collision instead of choosing arbitrarily", () => {
    const index = new ResourceUniverseIndex();
    const handwritten = producer("physical", "handwritten", modelKey, "local");
    const generated = {
      ...producer("rsgl", "unbuilt", modelKey, "local", "generated"),
      outputPath: handwritten.outputPath
    } satisfies ResourceProducer;
    index.replaceSnapshot(snapshot("physical", 1, [handwritten], [], authoritative("physical-r1")));
    index.replaceSnapshot(snapshot("rsgl", 1, [generated], [], authoritative("rsgl-r1")));

    const result = index.resolve(
      modelKey,
      resolutionContext("effective", ["local-layer"], ["physical", "rsgl"])
    );
    assert.strictEqual(result.status, "conflict");
    assert.deepStrictEqual(
      result.candidates.map(item => item.producer.producerId).sort(),
      [generated.producerId, handwritten.producerId].sort()
    );
  });

  it("does not rank providers excluded by the resolution context", () => {
    const index = new ResourceUniverseIndex();
    const physical = producer("physical", "handwritten", modelKey, "local");
    const generated = producer("rsgl", "unbuilt", modelKey, "local", "generated");
    index.replaceSnapshot(snapshot("physical", 1, [physical], []));
    index.replaceSnapshot(snapshot("rsgl", 1, [generated], []));

    const result = index.resolve(modelKey, resolutionContext(
      "effective",
      ["local-layer"],
      ["physical"]
    ));

    assert.strictEqual(result.status, "resolved");
    assert.deepStrictEqual(result.candidates.map(item => item.producer.providerId), ["physical"]);
  });

  it("validates provider ownership and edge source integrity before replacing an index", () => {
    const index = new ResourceUniverseIndex();
    const invalid = producer("physical", "handwritten", modelKey, "local");
    assert.throws(() => index.replaceSnapshot({
      ...snapshot("rsgl", 1, [invalid], []),
      providerId: "rsgl"
    }), /does not belong/);
    assert.throws(() => index.replaceSnapshot(snapshot("physical", 1, [], [{
      ...edge(invalid, textureKey),
      sourceProducerId: "missing"
    }])), /unknown source producer/);
  });

  it("validates an entire provider batch before replacing either snapshot", () => {
    const index = new ResourceUniverseIndex();
    const oldPhysical = producer("physical", "handwritten", modelKey, "local");
    index.replaceSnapshot(snapshot("physical", 1, [oldPhysical], []));
    const replacementKey: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/new" };
    const replacement = producer("physical", "handwritten", replacementKey, "local");
    const invalidRsgl = producer("physical", "unbuilt", textureKey, "local", "generated");

    assert.throws(() => index.replaceSnapshotsAtomically([
      snapshot("physical", 2, [replacement], []),
      snapshot("rsgl", 1, [invalidRsgl], [])
    ]), /does not belong/);
    assert.deepStrictEqual(index.getProducersForKey(modelKey).map(item => item.producerId), [
      oldPhysical.producerId
    ]);
    assert.deepStrictEqual(index.getProducersForKey(replacementKey), []);
  });

  function producer(
    providerId: string,
    state: ResourceProducer["materializationState"],
    key: ResourceGraphLogicalKey,
    layerRole: ResourceProducer["layerRole"],
    origin: ResourceProducer["origin"] = "physical"
  ): ResourceProducer {
    return {
      producerId: `${providerId}:${state}:${key.kind}:${key.id}`,
      providerId,
      projectId: "project",
      layerId: layerRole === "custom" ? "custom-layer" : layerRole === "vanilla" ? "vanilla-layer" : "local-layer",
      layerRole,
      origin,
      logicalKeys: [key],
      sourceOrigins: origin === "generated"
        ? [{ uri: "file:///workspace/rsgl/main.rsgl", origin: "generated", editable: true }]
        : [],
      physicalOrigins: origin === "physical"
        ? [{ uri: "file:///workspace/assets/demo/models/block/target.json", origin: "physical", editable: true }]
        : [],
      materializationState: state,
      outputPath: "assets/demo/models/block/target.json",
      revision: "r1"
    };
  }

  function edge(source: ResourceProducer, target: ResourceGraphLogicalKey): ResourceEdge {
    return {
      edgeId: `${source.producerId}->${target.kind}:${target.id}`,
      providerId: source.providerId,
      projectId: source.projectId,
      sourceProducerId: source.producerId,
      target,
      resolutionScope: "effective",
      resolutionContextId: "context",
      origin: "direct"
    };
  }

  function snapshot(
    providerId: string,
    generation: number,
    producers: readonly ResourceProducer[],
    edges: readonly ResourceEdge[],
    coverage: ProviderCoverage = authoritative(`${providerId}-r1`)
  ): ResourceProviderSnapshot {
    return {
      providerId,
      projectId: "project",
      generation,
      revision: `${providerId}-${generation}`,
      coverage,
      producers,
      edges
    };
  }

  function authoritative(revision: string): ProviderCoverage {
    return {
      status: "authoritative",
      revision,
      coveredScope: { projectId: "project" }
    };
  }

  function resolutionContext(
    scope: ResourceResolutionContext["scope"],
    orderedLayerIds: readonly string[],
    applicableProviderIds: readonly string[]
  ): ResourceResolutionContext {
    return {
      contextId: "context",
      projectId: "project",
      scope,
      orderedLayerIds,
      applicableProviderIds
    };
  }
});
