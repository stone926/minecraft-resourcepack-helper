import * as assert from "node:assert/strict";
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

  it("reuses sorted query results without exposing cached arrays or resolution candidates", () => {
    const index = new ResourceUniverseIndex();
    const first = producer("physical", "handwritten", modelKey, "local");
    const secondKey: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/second" };
    const second = producer("physical", "current", secondKey, "local");
    const firstEdge = edge(first, textureKey);
    const secondEdge = edge(second, textureKey);
    index.replaceSnapshot(snapshot("physical", 1, [second, first], [secondEdge, firstEdge]));
    const context = resolutionContext("effective", ["local-layer"], ["physical"]);

    const originalSort = Array.prototype.sort;
    let sortCalls = 0;
    Array.prototype.sort = function <T>(
      this: T[],
      compareFn?: (left: T, right: T) => number
    ): T[] {
      sortCalls += 1;
      return originalSort.call(this, compareFn) as T[];
    } as typeof Array.prototype.sort;
    try {
      const incoming = index.getIncoming(textureKey);
      const outgoing = index.getOutgoing(first.producerId);
      const projectProducers = index.getProjectProducers("project");
      const providerProducers = index.getProviderProjectProducers("physical", "project");
      const resolved = index.resolve(modelKey, context);
      assert.strictEqual(resolved.status, "resolved");

      incoming.length = 0;
      outgoing.length = 0;
      projectProducers.length = 0;
      providerProducers.length = 0;
      resolved.candidates[0].matchedAs = "alias";
      const warmupSortCalls = sortCalls;
      assert.ok(warmupSortCalls > 0);

      const incomingAgain = index.getIncoming(textureKey);
      const outgoingAgain = index.getOutgoing(first.producerId);
      const projectProducersAgain = index.getProjectProducers("project");
      const providerProducersAgain = index.getProviderProjectProducers("physical", "project");
      const resolvedAgain = index.resolve(modelKey, context);

      assert.strictEqual(sortCalls, warmupSortCalls, "warm queries must not sort cached facts again");
      assert.deepStrictEqual(incomingAgain.map(item => item.edgeId), [firstEdge.edgeId, secondEdge.edgeId].sort());
      assert.deepStrictEqual(outgoingAgain.map(item => item.edgeId), [firstEdge.edgeId]);
      assert.deepStrictEqual(
        projectProducersAgain.map(item => item.producerId),
        [first.producerId, second.producerId].sort()
      );
      assert.deepStrictEqual(
        providerProducersAgain.map(item => item.producerId),
        [first.producerId, second.producerId].sort()
      );
      assert.strictEqual(resolvedAgain.status, "resolved");
      assert.strictEqual(resolvedAgain.candidates[0].matchedAs, "concrete");
    } finally {
      Array.prototype.sort = originalSort;
    }
  });

  it("invalidates affected cached queries after snapshot replacement and removal", () => {
    const index = new ResourceUniverseIndex();
    const first = producer("physical", "handwritten", modelKey, "local");
    const firstEdge = edge(first, textureKey);
    const context = resolutionContext("effective", ["local-layer"], ["physical"]);
    index.replaceSnapshot(snapshot("physical", 1, [first], [firstEdge]));

    assert.strictEqual(index.resolve(modelKey, context).status, "resolved");
    assert.deepStrictEqual(index.getIncoming(textureKey).map(item => item.edgeId), [firstEdge.edgeId]);
    assert.deepStrictEqual(index.getOutgoing(first.producerId).map(item => item.edgeId), [firstEdge.edgeId]);
    assert.strictEqual(index.getProjectProducers("project")[0].revision, "r1");
    assert.strictEqual(index.getProviderProjectProducers("physical", "project")[0].revision, "r1");

    const replacementTarget: ResourceGraphLogicalKey = { kind: "texture", id: "demo:block/replacement" };
    assert.deepStrictEqual(index.getIncoming(replacementTarget), [], "negative results must also be cached safely");
    const replacement = {
      ...first,
      revision: "r2",
      outputPath: "assets/demo/models/block/replacement.json"
    } satisfies ResourceProducer;
    const replacementEdge = edge(replacement, replacementTarget);
    index.replaceSnapshot(snapshot("physical", 2, [replacement], [replacementEdge]));

    const replacedResolution = index.resolve(modelKey, context);
    assert.strictEqual(replacedResolution.status, "resolved");
    assert.strictEqual(replacedResolution.status === "resolved" ? replacedResolution.winner.revision : "", "r2");
    assert.deepStrictEqual(index.getIncoming(textureKey), []);
    assert.deepStrictEqual(index.getIncoming(replacementTarget).map(item => item.edgeId), [replacementEdge.edgeId]);
    assert.deepStrictEqual(index.getOutgoing(first.producerId).map(item => item.edgeId), [replacementEdge.edgeId]);
    assert.strictEqual(index.getProjectProducers("project")[0].revision, "r2");
    assert.strictEqual(index.getProviderProjectProducers("physical", "project")[0].revision, "r2");

    index.removeProviderProject("physical", "project");
    assert.deepStrictEqual(index.getIncoming(replacementTarget), []);
    assert.deepStrictEqual(index.getOutgoing(first.producerId), []);
    assert.deepStrictEqual(index.getProjectProducers("project"), []);
    assert.deepStrictEqual(index.getProviderProjectProducers("physical", "project"), []);
    assert.strictEqual(index.resolve(modelKey, context).status, "incomplete");
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

  it("excludes filter-blocked producers only when the blocking layer is in scope", () => {
    const index = new ResourceUniverseIndex();
    const blocked = {
      ...producer("physical", "handwritten", modelKey, "custom"),
      blockedByLayerIds: ["local-layer", "custom-high"]
    } satisfies ResourceProducer;
    const blockedEdge = edge(blocked, textureKey);
    index.replaceSnapshot(snapshot("physical", 1, [blocked], [blockedEdge]));

    const effectiveContext = resolutionContext(
      "effective",
      ["local-layer", "custom-high", "custom-layer"],
      ["physical"]
    );

    assert.strictEqual(index.resolve(
      modelKey,
      effectiveContext
    ).status, "missing");
    assert.strictEqual(index.resolve(
      modelKey,
      resolutionContext("custom", ["custom-high", "custom-layer"], ["physical"])
    ).status, "missing");
    assert.strictEqual(index.resolve(
      modelKey,
      resolutionContext("custom", ["custom-layer"], ["physical"])
    ).status, "resolved", "filters outside an explicit layer scope must not hide raw resources");
    assert.deepStrictEqual(index.getIncoming(textureKey).map(item => item.edgeId), [blockedEdge.edgeId]);
    assert.deepStrictEqual(
      index.getIncoming(textureKey, effectiveContext),
      [],
      "effective References queries must not expose edges from filtered lower-layer resources"
    );
    assert.deepStrictEqual(
      index.getIncoming(
        textureKey,
        resolutionContext("custom", ["custom-layer"], ["physical"])
      ).map(item => item.edgeId),
      [blockedEdge.edgeId]
    );
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
      contextId: [scope, ...orderedLayerIds, ...applicableProviderIds].join(":"),
      projectId: "project",
      scope,
      orderedLayerIds,
      applicableProviderIds
    };
  }
});
