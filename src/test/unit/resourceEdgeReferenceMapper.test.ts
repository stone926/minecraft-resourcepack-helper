import * as assert from "node:assert/strict";
import type {
  ResourceEdge,
  ResourceProducer
} from "../../resourceUniverse/core/types";
import {
  resourceReferenceForEdge,
  resourceSourceUriForEdge
} from "../../services/resourceEdgeReferenceMapper";

describe("resource edge reference mapper", () => {
  it("preserves lossless source-reference evidence and model-parent relationships", () => {
    const edge = resourceEdge({
      relationship: "modelParent",
      sourceReference: {
        value: "demo:block/base",
        target: "models",
        source: "assets",
        extension: "json",
        kind: "model"
      }
    });

    assert.deepStrictEqual(resourceReferenceForEdge(edge), {
      value: "demo:block/base",
      target: "models",
      source: "assets",
      extension: "json",
      kind: "model",
      valueNode: {},
      relationship: "modelParent"
    });
  });

  it("reconstructs canonical references from logical resource kinds", () => {
    const reference = resourceReferenceForEdge(resourceEdge({
      target: { kind: "texture", id: "demo:block/stone" }
    }));

    assert.deepStrictEqual(reference, {
      value: "demo:block/stone",
      valueNode: {},
      target: "textures",
      source: "assets",
      extension: "png",
      kind: "texture",
      relationship: undefined
    });
  });

  it("returns null for a logical kind that has no reference projection", () => {
    assert.strictEqual(resourceReferenceForEdge(resourceEdge({
      target: { kind: "unknownResourceKind", id: "demo:value" }
    })), null);
  });

  it("selects source location, source origin, then physical origin", () => {
    const producer = resourceProducer();
    assert.strictEqual(resourceSourceUriForEdge(resourceEdge({
      sourceLocation: {
        uri: "file:///workspace/source-location.rsgl",
        origin: "generated"
      }
    }), producer), "file:///workspace/source-location.rsgl");
    assert.strictEqual(
      resourceSourceUriForEdge(resourceEdge(), producer),
      "file:///workspace/source-origin.rsgl"
    );
    assert.strictEqual(
      resourceSourceUriForEdge(resourceEdge(), {
        ...producer,
        sourceOrigins: []
      }),
      "file:///workspace/assets/demo/models/block/generated.json"
    );
    assert.strictEqual(resourceSourceUriForEdge(resourceEdge()), null);
  });

  it("collapses shader variants while retaining their concrete extension", () => {
    const reference = resourceReferenceForEdge(resourceEdge({
      target: { kind: "shaderVertex", id: "demo:core/example" }
    }));

    assert.strictEqual(reference?.kind, "shader");
    assert.strictEqual(reference?.target, "shaders");
    assert.strictEqual(reference?.extension, "vsh");
  });
});

function resourceEdge(overrides: Partial<ResourceEdge> = {}): ResourceEdge {
  return {
    edgeId: "edge",
    providerId: "rsgl",
    projectId: "project",
    sourceProducerId: "producer",
    target: { kind: "model", id: "demo:block/generated" },
    resolutionScope: "effective",
    resolutionContextId: "project:effective",
    origin: "direct",
    ...overrides
  };
}

function resourceProducer(): ResourceProducer {
  return {
    producerId: "producer",
    providerId: "rsgl",
    projectId: "project",
    layerId: "local",
    layerRole: "local",
    origin: "generated",
    logicalKeys: [{ kind: "model", id: "demo:block/generated" }],
    sourceOrigins: [{
      uri: "file:///workspace/source-origin.rsgl",
      origin: "generated"
    }],
    physicalOrigins: [{
      uri: "file:///workspace/assets/demo/models/block/generated.json",
      origin: "materialized"
    }],
    materializationState: "current",
    revision: "r1"
  };
}
