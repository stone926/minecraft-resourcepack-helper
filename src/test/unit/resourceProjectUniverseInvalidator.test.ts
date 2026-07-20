import * as assert from "node:assert";
import type { ResourcePackProjectContextDto } from "../../../packages/resource-project/src";
import { ResourceProjectUniverseInvalidator } from "../../services/resourceProjectUniverseInvalidator";
import {
  ResourceUniverseService,
  type ResourceProducer,
  type ResourceProviderSnapshot
} from "../../resourceUniverse";

describe("resource project universe invalidation", () => {
  it("routes target create/delete to the affected project and forces winner reselection", () => {
    const context = projectContext();
    const universe = new ResourceUniverseService();
    const target = { kind: "model", id: "demo:block/target" };
    const producer = physicalProducer();
    universe.index.replaceSnapshot(snapshot(1, [producer]));
    const invalidator = new ResourceProjectUniverseInvalidator({
      getCachedContexts: () => [context],
      findCachedContextsForUri: uri => uri.startsWith(context.outputPackRootUri) ? [context] : []
    }, universe);

    assert.deepStrictEqual(invalidator.invalidatePhysicalUri(
      "file:///workspace/pack/assets/demo/models/block/target.json"
    ), [context.projectId]);
    assert.strictEqual(universe.index.getCoverage("physical", context.projectId)?.status, "unavailable");
    assert.deepStrictEqual(universe.index.getProducersForKey(target).map(item => item.producerId), [
      producer.producerId
    ], "stale facts remain visible until the replacement scan commits");

    universe.index.replaceSnapshot(snapshot(3, []));
    assert.deepStrictEqual(universe.index.getProducersForKey(target), [], "delete removes the old winner");

    universe.index.replaceSnapshot(snapshot(4, [producer]));
    assert.deepStrictEqual(universe.index.getProducersForKey(target).map(item => item.producerId), [
      producer.producerId
    ], "create makes the target selectable again");
  });

  it("does not invalidate unrelated cached projects", () => {
    const context = projectContext();
    const universe = new ResourceUniverseService();
    universe.index.replaceSnapshot(snapshot(1, [physicalProducer()]));
    const invalidator = new ResourceProjectUniverseInvalidator({
      getCachedContexts: () => [context],
      findCachedContextsForUri: () => []
    }, universe);

    assert.deepStrictEqual(invalidator.invalidatePhysicalUri(
      "file:///other-pack/assets/demo/models/other.json"
    ), []);
    assert.strictEqual(universe.index.getCoverage("physical", context.projectId)?.status, "authoritative");
  });
});

function projectContext(): ResourcePackProjectContextDto {
  return {
    projectId: "project",
    workspaceFolderUri: "file:///workspace",
    projectRootUri: "file:///workspace/pack",
    packRootUri: "file:///workspace/pack",
    assetsRootUri: "file:///workspace/pack/assets",
    rsglSourceRootUris: ["file:///workspace/pack/rsgl"],
    outputPackRootUri: "file:///workspace/pack",
    outputAssetsRootUri: "file:///workspace/pack/assets",
    localLayer: {
      layerId: "local",
      role: "local",
      source: "directory",
      rootUri: "file:///workspace/pack",
      priority: 0,
      metadataRevision: "metadata-r1"
    },
    externalLayers: [],
    overlaySelection: [],
    configurationRevision: "config-r1",
    contextRevision: "context-r1"
  };
}

function physicalProducer(): ResourceProducer {
  return {
    producerId: "physical:target",
    providerId: "physical",
    projectId: "project",
    layerId: "local",
    layerRole: "local",
    origin: "physical",
    logicalKeys: [{ kind: "model", id: "demo:block/target" }],
    sourceOrigins: [],
    physicalOrigins: [{
      uri: "file:///workspace/pack/assets/demo/models/block/target.json",
      origin: "physical",
      editable: true
    }],
    materializationState: "handwritten",
    outputPath: "assets/demo/models/block/target.json",
    revision: "target-r1"
  };
}

function snapshot(generation: number, producers: readonly ResourceProducer[]): ResourceProviderSnapshot {
  return {
    providerId: "physical",
    projectId: "project",
    generation,
    revision: `physical-r${generation}`,
    coverage: {
      status: "authoritative",
      revision: `physical-r${generation}`,
      coveredScope: { projectId: "project" }
    },
    producers,
    edges: []
  };
}
