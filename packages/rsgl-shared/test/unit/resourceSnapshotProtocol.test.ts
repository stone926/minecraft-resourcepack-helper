import * as assert from "node:assert";
import {
  isRsglResourceSnapshotInvalidationNotification,
  isRsglResourceSnapshotRequest,
  isRsglResourceSnapshotResponse,
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceSnapshotRequest,
  type RsglResourceSnapshotResponse
} from "../../src";

describe("RSGL resource snapshot protocol", () => {
  it("accepts URI-safe project requests and rejects native paths or protocol drift", () => {
    const request = validRequest();
    assert.strictEqual(isRsglResourceSnapshotRequest(request), true);
    assert.strictEqual(isRsglResourceSnapshotRequest({ ...request, protocolVersion: 2 }), false);
    assert.strictEqual(isRsglResourceSnapshotRequest({
      ...request,
      projectContext: { ...request.projectContext, outputPackRootUri: "C:\\pack" }
    }), false);
    assert.strictEqual(isRsglResourceSnapshotRequest({
      ...request,
      scope: { kind: "project", projectId: "other" }
    }), false);
  });

  it("requires authoritative and partial snapshots to carry contentless facts", () => {
    const response: RsglResourceSnapshotResponse = {
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: "project-a",
      requestGeneration: 4,
      revision: "r4",
      status: "ok",
      coverage: {
        status: "authoritative",
        revision: "r4",
        coveredScope: { projectId: "project-a", resolutionScopes: ["effective"] }
      },
      resources: [{
        producerId: "producer-a",
        kind: "model",
        logicalKeys: [{ kind: "model", id: "demo:block/a" }],
        outputPath: "assets/demo/models/block/a.json",
        sourceOrigins: [{
          uri: "file:///workspace/rsgl/a.rsgl",
          range: { start: 2, end: 8 },
          documentVersion: 7,
          documentSignature: "sha256:source"
        }],
        revision: "producer-r4"
      }],
      edges: []
    };

    assert.strictEqual(isRsglResourceSnapshotResponse(response), true);
    assert.strictEqual(isRsglResourceSnapshotResponse({
      ...response,
      resources: [{ ...response.resources![0], content: "must-not-cross-protocol" }]
    }), false);
    assert.strictEqual(isRsglResourceSnapshotResponse({
      ...response,
      revision: "different"
    }), false);
  });

  it("keeps unavailable/not-modified distinct from authoritative empty snapshots", () => {
    const request = validRequest();
    assert.strictEqual(isRsglResourceSnapshotResponse({
      protocolVersion: 1,
      projectId: request.projectContext.projectId,
      requestGeneration: 1,
      status: "unavailable",
      coverage: { status: "unavailable", reason: "lspFailed" }
    }), true);
    assert.strictEqual(isRsglResourceSnapshotResponse({
      protocolVersion: 1,
      projectId: request.projectContext.projectId,
      requestGeneration: 1,
      status: "unavailable",
      coverage: { status: "unavailable", reason: "lspFailed" },
      resources: [],
      edges: []
    }), false);
    assert.strictEqual(isRsglResourceSnapshotResponse({
      protocolVersion: 1,
      projectId: request.projectContext.projectId,
      requestGeneration: 1,
      revision: "r1",
      status: "notModified",
      coverage: {
        status: "authoritative",
        revision: "r1",
        coveredScope: { projectId: request.projectContext.projectId }
      }
    }), true);
  });

  it("accepts stale-only invalidations and rejects pushed snapshot payloads", () => {
    const notification = {
      protocolVersion: 1,
      projectId: "project-a",
      invalidationRevision: "invalidation-3",
      reason: "dependency",
      affectedSourceUris: ["vscode-remote://ssh-remote+host/workspace/rsgl/a.rsgl"]
    };
    assert.strictEqual(isRsglResourceSnapshotInvalidationNotification(notification), true);
    assert.strictEqual(isRsglResourceSnapshotInvalidationNotification({
      ...notification,
      resources: []
    }), false);
  });
});

function validRequest(): RsglResourceSnapshotRequest {
  const localLayer = {
    layerId: "local",
    role: "local" as const,
    source: "directory" as const,
    rootUri: "file:///workspace/pack",
    priority: 0,
    metadataRevision: "metadata-r1"
  };
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectContext: {
      projectId: "project-a",
      workspaceFolderUri: "file:///workspace",
      projectRootUri: "file:///workspace/pack",
      packRootUri: "file:///workspace/pack",
      assetsRootUri: "file:///workspace/pack/assets",
      rsglSourceRootUris: ["file:///workspace/pack/rsgl"],
      outputPackRootUri: "file:///workspace/pack",
      outputAssetsRootUri: "file:///workspace/pack/assets",
      localLayer,
      externalLayers: [],
      overlaySelection: [],
      configurationRevision: "config-r1",
      contextRevision: "context-r1"
    },
    scope: { kind: "project", projectId: "project-a" },
    requestGeneration: 1
  };
}
