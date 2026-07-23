import * as assert from "node:assert";
import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import {
  ResourceNavigationService,
  ResourceUniverseIndex,
  type ResourceProducer,
  type ResourceProviderSnapshot,
  type ResourceResolutionContext
} from "../../resourceUniverse";

describe("resource navigation service", () => {
  const target: ResourceGraphLogicalKey = { kind: "model", id: "demo:block/generated" };
  const context: ResourceResolutionContext = {
    contextId: "project:effective",
    projectId: "project",
    scope: "effective",
    orderedLayerIds: ["local"],
    applicableProviderIds: ["rsgl"]
  };

  it("prefers editable RSGL source over a current materialized origin", () => {
    const sourceUri = "file:///workspace/rsgl/main.rsgl";
    const materializedUri = "file:///workspace/assets/demo/models/block/generated.json";
    const producer = generatedProducer(sourceUri, materializedUri);
    const service = serviceWith(snapshot([producer]));
    const result = service.resolveDefinition(target, context);

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.status === "resolved" ? result.primary.uri : "", sourceUri);
    assert.deepStrictEqual(
      result.status === "resolved" ? result.alternatives.map(location => location.uri) : [],
      [materializedUri]
    );
  });

  it("can explicitly select a materialized origin without changing producer identity", () => {
    const sourceUri = "file:///workspace/rsgl/main.rsgl";
    const materializedUri = "file:///workspace/assets/demo/models/block/generated.json";
    const producer = generatedProducer(sourceUri, materializedUri);
    const result = serviceWith(snapshot([producer])).resolveDefinition(target, context, {
      preferMaterialized: true
    });

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.status === "resolved" ? result.primary.uri : "", materializedUri);
  });

  it("uses an active source origin when one producer has multiple declaration origins", () => {
    const producer = generatedProducer(
      "file:///workspace/rsgl/templates.rsgl",
      "file:///workspace/assets/demo/models/block/generated.json"
    );
    producer.sourceOrigins = [
      ...producer.sourceOrigins,
      { uri: "file:///workspace/rsgl/main.rsgl", range: { start: 10, end: 20 }, origin: "generated", editable: true }
    ];
    const result = serviceWith(snapshot([producer])).resolveDefinition(target, context, {
      activeUri: "file:///workspace/rsgl/main.rsgl"
    });

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.status === "resolved" ? result.primary.uri : "", "file:///workspace/rsgl/main.rsgl");
  });

  it("uses canonical Windows URI identity for active-origin ranking and deduplication", () => {
    const producer = generatedProducer(
      "file:///workspace/rsgl/templates.rsgl",
      ""
    );
    producer.sourceOrigins = [
      ...producer.sourceOrigins,
      {
        uri: "file:///E:/pack/rsgl/main.rsgl",
        range: { start: 10, end: 20 },
        origin: "generated",
        editable: true
      },
      {
        uri: "file:///e%3A/pack/rsgl/main.rsgl",
        range: { start: 10, end: 20 },
        origin: "generated",
        editable: true
      }
    ];
    const result = serviceWith(snapshot([producer])).resolveDefinition(target, context, {
      activeUri: "file:///e%3A/pack/rsgl/main.rsgl"
    });

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(
      result.status === "resolved" ? result.primary.uri : "",
      "file:///E:/pack/rsgl/main.rsgl"
    );
    assert.strictEqual(
      result.status === "resolved"
        ? result.alternatives.filter(location => location.range?.start === 10).length
        : -1,
      0,
      "equivalent Windows URI serializations should collapse to one primary location"
    );
  });

  it("reports unavailable coverage instead of claiming a target is missing", () => {
    const index = new ResourceUniverseIndex();
    index.replaceSnapshot({
      ...snapshot([]),
      coverage: { status: "unavailable", reason: "lspFailed" }
    });
    const result = new ResourceNavigationService(index).resolveDefinition(target, context);
    assert.deepStrictEqual(result, {
      status: "incomplete",
      target,
      reason: "providerUnavailable",
      candidates: []
    });
  });

  it("returns structured no-origin state for an unchecked external declaration", () => {
    const producer = generatedProducer("file:///workspace/rsgl/main.rsgl", "");
    producer.sourceOrigins = [];
    producer.physicalOrigins = [];
    const result = serviceWith(snapshot([producer])).resolveDefinition(target, context);
    assert.deepStrictEqual(result, {
      status: "missing",
      target,
      reason: "noNavigableOrigin",
      candidates: [producer]
    });
  });

  function serviceWith(providerSnapshot: ResourceProviderSnapshot): ResourceNavigationService {
    const index = new ResourceUniverseIndex();
    index.replaceSnapshot(providerSnapshot);
    return new ResourceNavigationService(index);
  }

  function snapshot(producers: readonly ResourceProducer[]): ResourceProviderSnapshot {
    return {
      providerId: "rsgl",
      projectId: "project",
      generation: 1,
      revision: "r1",
      coverage: {
        status: "authoritative",
        revision: "r1",
        coveredScope: { projectId: "project" }
      },
      producers,
      edges: []
    };
  }

  function generatedProducer(sourceUri: string, materializedUri: string): ResourceProducer {
    return {
      producerId: "rsgl:generated",
      providerId: "rsgl",
      projectId: "project",
      layerId: "local",
      layerRole: "local",
      origin: "generated",
      logicalKeys: [target],
      sourceOrigins: sourceUri
        ? [{ uri: sourceUri, range: { start: 1, end: 9 }, origin: "generated", editable: true }]
        : [],
      physicalOrigins: materializedUri
        ? [{ uri: materializedUri, origin: "materialized", editable: true }]
        : [],
      materializationState: materializedUri ? "current" : "unbuilt",
      outputPath: "assets/demo/models/block/generated.json",
      revision: "r1"
    };
  }
});
