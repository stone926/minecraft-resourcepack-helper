import * as assert from "node:assert/strict";
import {
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceDto,
  type RsglResourceSnapshotResponse
} from "../../../packages/rsgl-shared/src";
import {
  RsglGeneratedProvider,
  RsglGeneratedProviderConnection
} from "../../rsgl/provider";
import {
  ResourceUniverseService,
  type ResourceContributionRequest
} from "../../resourceUniverse";

describe("RSGL generated resource provider", () => {
  it("maps contentless project producers, source origins, edges, and coverage", async () => {
    const source = new StubSnapshotSource(request => okResponse(request, [resource("generated")], [{
      edgeId: "edge:model-texture",
      sourceProducerId: producerId("generated"),
      target: { kind: "texture", id: "demo:block/stone" },
      resolutionScope: "effective",
      resolutionContextId: "project:effective",
      sourceLocation: {
        uri: "file:///workspace/rsgl/main.rsgl",
        range: { start: 30, end: 46 },
        documentVersion: 7,
        documentSignature: "document-r7"
      },
      sourceGeneratedPath: "/textures/all",
      relationship: "texture",
      origin: "direct",
      resolvedTarget: { status: "generated" }
    }]));
    const universe = new ResourceUniverseService();
    const provider = createProvider(source);
    const connection = new RsglGeneratedProviderConnection(universe, provider);

    const refresh = await connection.refreshProject("project");

    assert.strictEqual(refresh.applied, true);
    assert.strictEqual(source.calls.length, 1);
    assert.deepStrictEqual(source.calls[0], {
      projectId: "project",
      scope: { projectId: "project" },
      knownRevision: undefined,
      requestGeneration: 1
    });
    const producer = universe.getProducer(producerId("generated"));
    assert.deepStrictEqual(producer, {
      producerId: producerId("generated"),
      providerId: "rsgl",
      projectId: "project",
      layerId: "project-local-layer",
      layerRole: "local",
      origin: "generated",
      logicalKeys: [{ kind: "model", id: "demo:block/generated" }],
      aliasKeys: [],
      aggregateMemberships: [],
      sourceOrigins: [{
        uri: "file:///workspace/rsgl/main.rsgl",
        range: { start: 10, end: 20 },
        editable: true,
        origin: "generated"
      }],
      physicalOrigins: [],
      materializationState: "unbuilt",
      outputPath: "assets/demo/models/block/generated.json",
      revision: "producer-generated-r1"
    });
    assert.deepStrictEqual(universe.getOutgoing(producerId("generated")), [{
      edgeId: "edge:model-texture",
      providerId: "rsgl",
      projectId: "project",
      sourceProducerId: producerId("generated"),
      target: { kind: "texture", id: "demo:block/stone" },
      resolutionScope: "effective",
      resolutionContextId: "project:effective",
      sourceLocation: {
        uri: "file:///workspace/rsgl/main.rsgl",
        range: { start: 30, end: 46 },
        editable: true,
        origin: "generated"
      },
      sourceGeneratedPath: "/textures/all",
      relationship: "texture",
      origin: "direct"
    }]);
    assert.strictEqual(universe.index.getCoverage("rsgl", "project")?.status, "authoritative");
    connection.dispose();
  });

  it("projects Windows source origins across Node and VS Code URI serializations", async () => {
    const generated = {
      ...resource("windows"),
      sourceOrigins: [{
        uri: "file:///E:/.minecraft/resourcepacks/better_textures/rsgl/leaves.rsgl",
        range: { start: 10, end: 20 },
        documentVersion: 7,
        documentSignature: "document-r7"
      }]
    };
    const source = new StubSnapshotSource(request => okResponse(request, [generated]));
    const universe = new ResourceUniverseService();
    const provider = createProvider(source);
    const connection = new RsglGeneratedProviderConnection(universe, provider);
    await connection.refreshProject("project");

    const [projection] = universe.getDocumentProjections({
      uri: "file:///e%3A/.minecraft/resourcepacks/better_textures/rsgl/leaves.rsgl",
      fileName: "E:\\.minecraft\\resourcepacks\\better_textures\\rsgl\\leaves.rsgl",
      languageId: "rsgl"
    }, "project");

    assert.deepStrictEqual(
      projection.resources.map(producer => producer.producerId),
      [producerId("windows")]
    );
    connection.dispose();
  });

  it("retains last-known siblings for partial and unavailable responses", async () => {
    let responseNumber = 0;
    const source = new StubSnapshotSource(request => {
      responseNumber += 1;
      if (responseNumber === 1) {
        return okResponse(request, [resource("first"), resource("sibling")]);
      }
      if (responseNumber === 2) {
        return partialResponse(request, [resource("first", "producer-first-r2")]);
      }
      return unavailableResponse(request, "lspFailed", "snapshot-r2");
    });
    const universe = new ResourceUniverseService();
    const provider = createProvider(source);
    const connection = new RsglGeneratedProviderConnection(universe, provider);

    await connection.refreshProject("project");
    await connection.refreshProject("project");

    assert.strictEqual(universe.index.getCoverage("rsgl", "project")?.status, "partial");
    assert.strictEqual(universe.getProducer(producerId("first"))?.revision, "producer-first-r2");
    assert.ok(universe.getProducer(producerId("sibling")), "partial must retain unavailable-scope siblings");
    assert.deepStrictEqual(provider.getProjectState("project"), {
      projectId: "project",
      revision: "snapshot-r2",
      coverage: {
        status: "partial",
        revision: "snapshot-r2",
        authoritativeScopes: [{ projectId: "project", pathPrefixes: ["block/first"] }],
        unavailableScopes: [{ projectId: "project", pathPrefixes: ["block/sibling"] }],
        skippedSourceUris: ["file:///workspace/rsgl/broken.rsgl"]
      },
      stale: false,
      skippedSourceUris: ["file:///workspace/rsgl/broken.rsgl"],
      issues: []
    });

    await connection.refreshProject("project");
    assert.strictEqual(universe.index.getCoverage("rsgl", "project")?.status, "unavailable");
    assert.ok(universe.getProducer(producerId("first")));
    assert.ok(universe.getProducer(producerId("sibling")));
    connection.dispose();
  });

  it("reprojects notModified facts with ownership-proven current materialization", async () => {
    const source = new StubSnapshotSource(request => request.knownRevision
      ? notModifiedResponse(request, request.knownRevision)
      : okResponse(request, [resource("generated")])
    );
    const universe = new ResourceUniverseService();
    const provider = createProvider(source);
    const connection = new RsglGeneratedProviderConnection(universe, provider);
    await connection.refreshProject("project");

    const materialized = await connection.replaceMaterializations({
      projectId: "project",
      revision: "materialization-r1",
      entries: [{
        producerId: producerId("generated"),
        outputPath: "assets/demo/models/block/generated.json",
        state: "current",
        owned: true,
        producerRevision: "producer-generated-r1",
        locations: [{ uri: "file:///workspace/assets/demo/models/block/generated.json" }]
      }]
    });

    assert.strictEqual(materialized?.applied, true);
    assert.strictEqual(source.calls[1].knownRevision, "snapshot-r1");
    const producers = universe.index.getProducersForKey({
      kind: "model",
      id: "demo:block/generated"
    });
    assert.strictEqual(producers.length, 1, "source and materialized locations share one producer identity");
    assert.strictEqual(producers[0].materializationState, "current");
    assert.deepStrictEqual(producers[0].physicalOrigins, [{
      uri: "file:///workspace/assets/demo/models/block/generated.json",
      origin: "materialized",
      editable: true
    }]);
    assert.deepStrictEqual([...provider.getOwnedOutputPaths("project")], [
      "assets/demo/models/block/generated.json"
    ]);

    const unchanged = await connection.replaceMaterializations({
      projectId: "project",
      revision: "materialization-r1",
      entries: [{
        producerId: producerId("generated"),
        outputPath: "assets/demo/models/block/generated.json",
        state: "current",
        owned: true,
        producerRevision: "producer-generated-r1",
        locations: [{ uri: "file:///workspace/assets/demo/models/block/generated.json" }]
      }]
    });
    assert.strictEqual(unchanged, undefined);
    assert.strictEqual(source.calls.length, 2, "same materialization transaction causes no extra snapshot request");
    connection.dispose();
  });

  it("keeps unowned collisions separate and downgrades outdated materializations to stale", async () => {
    const source = new StubSnapshotSource(request => request.knownRevision
      ? notModifiedResponse(request, request.knownRevision)
      : okResponse(request, [resource("generated")])
    );
    const universe = new ResourceUniverseService();
    const provider = createProvider(source);
    const connection = new RsglGeneratedProviderConnection(universe, provider);
    await connection.refreshProject("project");

    await connection.replaceMaterializations({
      projectId: "project",
      revision: "materialization-r1",
      entries: [{
        producerId: producerId("generated"),
        outputPath: "assets/demo/models/block/generated.json",
        state: "current",
        owned: true,
        producerRevision: "older-producer-revision",
        locations: [{ uri: "file:///workspace/assets/demo/models/block/generated.json" }]
      }]
    });
    assert.strictEqual(universe.getProducer(producerId("generated"))?.materializationState, "stale");

    await connection.replaceMaterializations({
      projectId: "project",
      revision: "materialization-r2",
      entries: [{
        producerId: producerId("generated"),
        outputPath: "assets/demo/models/block/generated.json",
        state: "conflict",
        owned: false,
        locations: [{ uri: "file:///workspace/assets/demo/models/block/generated.json" }]
      }]
    });
    const collided = universe.getProducer(producerId("generated"));
    assert.strictEqual(collided?.materializationState, "conflict");
    assert.deepStrictEqual(collided?.physicalOrigins, []);
    assert.deepStrictEqual([...provider.getOwnedOutputPaths("project")], []);
    connection.dispose();
  });

  it("invalidates one project as stale without deleting last-known or sibling facts", async () => {
    const source = new StubSnapshotSource(request => okResponse(request, [
      resource(request.projectId === "project-a" ? "a" : "b")
    ], [], `snapshot-${request.projectId}`));
    const universe = new ResourceUniverseService();
    const provider = new RsglGeneratedProvider(source, {
      localLayerIdForProject: projectId => `${projectId}-local-layer`
    });
    const connection = new RsglGeneratedProviderConnection(universe, provider);
    await connection.refreshProject("project-a");
    await connection.refreshProject("project-b");

    const notification = {
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: "project-a",
      invalidationRevision: "invalidation-a1",
      reason: "document" as const,
      affectedSourceUris: ["file:///workspace/rsgl/main.rsgl"]
    };
    assert.strictEqual(connection.acceptInvalidation(notification), true);
    assert.strictEqual(connection.acceptInvalidation(notification), false, "duplicate invalidation is coalesced");

    assert.strictEqual(universe.index.getCoverage("rsgl", "project-a")?.status, "unavailable");
    assert.strictEqual(universe.index.getCoverage("rsgl", "project-b")?.status, "authoritative");
    assert.ok(universe.getProducer(producerId("a")));
    assert.ok(universe.getProducer(producerId("b")));
    assert.deepStrictEqual(provider.getProjectState("project-a"), {
      projectId: "project-a",
      revision: "snapshot-project-a",
      coverage: {
        status: "unavailable",
        reason: "stale",
        lastKnownRevision: "snapshot-project-a"
      },
      stale: true,
      invalidationRevision: "invalidation-a1",
      skippedSourceUris: [],
      issues: []
    });
    connection.dispose();
  });

  it("turns malformed, mismatched, or cacheless notModified responses into unavailable coverage", async () => {
    let mode: "malformed" | "mismatch" | "notModified" = "malformed";
    const source = new StubSnapshotSource(request => {
      if (mode === "malformed") {
        return { protocolVersion: rsglResourceSnapshotProtocolVersion, status: "ok" };
      }
      if (mode === "mismatch") {
        return okResponse({ ...request, projectId: "other" }, []);
      }
      return notModifiedResponse(request, "unknown-revision");
    });
    const provider = createProvider(source);

    const malformed = await provider.getSnapshot(request(1), new AbortController().signal);
    assert.deepStrictEqual(malformed.coverage, {
      status: "unavailable",
      reason: "protocolMismatch"
    });
    mode = "mismatch";
    const mismatch = await provider.getSnapshot(request(2), new AbortController().signal);
    assert.strictEqual(mismatch.coverage.status, "unavailable");
    mode = "notModified";
    const notModified = await provider.getSnapshot({
      ...request(3),
      knownRevision: "unknown-revision"
    }, new AbortController().signal);
    assert.deepStrictEqual(notModified.coverage, {
      status: "unavailable",
      reason: "protocolMismatch"
    });
  });

  it("rejects a response that completes after a project invalidation", async () => {
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => {
      complete = resolve;
    });
    const source = new StubSnapshotSource(() => pending);
    const provider = createProvider(source);
    const controller = new AbortController();
    const snapshot = provider.getSnapshot(request(1), controller.signal);

    assert.strictEqual(provider.acceptInvalidation({
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: "project",
      invalidationRevision: "invalidation-r1",
      reason: "dependency"
    }), "project");
    complete(okResponse(request(1), [resource("late")]));

    assert.deepStrictEqual((await snapshot).coverage, {
      status: "unavailable",
      reason: "stale"
    });
    assert.strictEqual(provider.getProjectState("project")?.revision, undefined);
  });
});

class StubSnapshotSource {
  public readonly calls: ResourceContributionRequest[] = [];

  public constructor(
    private readonly respond: (request: ResourceContributionRequest) => unknown | Promise<unknown>
  ) {}

  public async requestSnapshot(request: ResourceContributionRequest): Promise<unknown> {
    this.calls.push({ ...request, scope: { ...request.scope } });
    return this.respond(request);
  }
}

function createProvider(source: StubSnapshotSource): RsglGeneratedProvider {
  return new RsglGeneratedProvider(source, {
    localLayerIdForProject: projectId => `${projectId}-local-layer`
  });
}

function request(generation: number): ResourceContributionRequest {
  return {
    projectId: "project",
    scope: { projectId: "project" },
    requestGeneration: generation
  };
}

function resource(name: string, revision = `producer-${name}-r1`): RsglResourceDto {
  return {
    producerId: producerId(name),
    kind: "model",
    logicalKeys: [{ kind: "model", id: `demo:block/${name}` }],
    outputPath: `assets/demo/models/block/${name}.json`,
    sourceOrigins: [{
      uri: "file:///workspace/rsgl/main.rsgl",
      range: { start: 10, end: 20 },
      documentVersion: 7,
      documentSignature: "document-r7"
    }],
    revision
  };
}

function producerId(name: string): string {
  return `rsgl:project:${name}`;
}

function okResponse(
  requestValue: ResourceContributionRequest,
  resources: readonly RsglResourceDto[],
  edges: NonNullable<RsglResourceSnapshotResponse["edges"]> = [],
  revision = "snapshot-r1"
): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: requestValue.projectId,
    requestGeneration: requestValue.requestGeneration,
    revision,
    status: "ok",
    coverage: {
      status: "authoritative",
      revision,
      coveredScope: { projectId: requestValue.projectId }
    },
    resources,
    edges
  };
}

function partialResponse(
  requestValue: ResourceContributionRequest,
  resources: readonly RsglResourceDto[]
): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: requestValue.projectId,
    requestGeneration: requestValue.requestGeneration,
    revision: "snapshot-r2",
    status: "partial",
    coverage: {
      status: "partial",
      revision: "snapshot-r2",
      authoritativeScopes: [{ projectId: requestValue.projectId, pathPrefixes: ["block/first"] }],
      unavailableScopes: [{ projectId: requestValue.projectId, pathPrefixes: ["block/sibling"] }],
      skippedSourceUris: ["file:///workspace/rsgl/broken.rsgl"]
    },
    resources,
    edges: [],
    skippedSourceUris: ["file:///workspace/rsgl/broken.rsgl"]
  };
}

function unavailableResponse(
  requestValue: ResourceContributionRequest,
  reason: "lspFailed" | "stale",
  lastKnownRevision: string
): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: requestValue.projectId,
    requestGeneration: requestValue.requestGeneration,
    status: "unavailable",
    coverage: { status: "unavailable", reason, lastKnownRevision }
  };
}

function notModifiedResponse(
  requestValue: ResourceContributionRequest,
  revision: string
): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: requestValue.projectId,
    requestGeneration: requestValue.requestGeneration,
    revision,
    status: "notModified",
    coverage: {
      status: "authoritative",
      revision,
      coveredScope: { projectId: requestValue.projectId }
    }
  };
}
