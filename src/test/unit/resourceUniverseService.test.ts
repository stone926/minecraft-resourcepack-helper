import * as assert from "node:assert";
import {
  ResourceUniverseService,
  type ResourceContributionProvider,
  type ResourceContributionRequest,
  type ResourceProducer,
  type ResourceProviderSnapshot
} from "../../resourceUniverse";

describe("resource universe service", () => {
  it("single-flights one provider/project/scope snapshot request", async () => {
    const service = new ResourceUniverseService();
    const pending = deferred<ResourceProviderSnapshot>();
    const calls: ResourceContributionRequest[] = [];
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async request => {
        calls.push(request);
        return pending.promise;
      }
    });

    const first = service.refreshProviderProject("physical", "project");
    const second = service.refreshProviderProject("physical", "project");
    assert.strictEqual(calls.length, 1);
    pending.resolve(emptySnapshot("physical", "project", calls[0].requestGeneration));

    assert.strictEqual((await first).applied, true);
    assert.strictEqual((await second).applied, true);
    assert.strictEqual(calls.length, 1);
  });

  it("aborts invalidated work and rejects its stale generation", async () => {
    const service = new ResourceUniverseService();
    const pending = deferred<ResourceProviderSnapshot>();
    let request: ResourceContributionRequest | undefined;
    let providerSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async (value, signal) => {
        request = value;
        providerSignal = signal;
        return pending.promise;
      }
    });

    const refresh = service.refreshProviderProject("rsgl", "project");
    service.invalidateProviderProject("rsgl", "project");
    assert.strictEqual(providerSignal?.aborted, true);
    assert.ok(request);
    pending.resolve(emptySnapshot("rsgl", "project", request.requestGeneration));

    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: [emptySnapshot("rsgl", "project", request.requestGeneration)]
    });
    assert.strictEqual(service.index.getCoverage("rsgl", "project")?.status, "unavailable");
  });

  it("commits a multi-provider project refresh atomically", async () => {
    const service = new ResourceUniverseService();
    const oldModel = producer("physical", "old");
    service.index.replaceSnapshot(snapshot("physical", 1, [oldModel]));
    service.registerProvider(providerWith("physical", request =>
      snapshot("physical", request.requestGeneration, [producer("physical", "new")])
    ));
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async () => {
        throw new Error("LSP unavailable");
      }
    });

    await assert.rejects(
      service.refreshProject("project", { projectId: "project" }, ["physical", "rsgl"]),
      /LSP unavailable/
    );
    assert.deepStrictEqual(
      service.index.getProducersForKey({ kind: "model", id: "demo:old" }).map(item => item.producerId),
      [oldModel.producerId],
      "a failed batch must not expose an earlier provider's new snapshot"
    );
    assert.deepStrictEqual(
      service.index.getProducersForKey({ kind: "model", id: "demo:new" }),
      []
    );
  });

  it("marks last-known facts stale instead of deleting them during invalidation", async () => {
    const service = new ResourceUniverseService();
    service.registerProvider(providerWith("physical", request =>
      snapshot("physical", request.requestGeneration, [producer("physical", "known")])
    ));
    await service.refreshProviderProject("physical", "project");

    service.invalidateProject("project");

    assert.deepStrictEqual(
      service.index.getProducersForKey({ kind: "model", id: "demo:known" })
        .map(item => item.producerId),
      ["physical:known"]
    );
    assert.strictEqual(service.index.getCoverage("physical", "project")?.status, "unavailable");
  });

  it("removes obsolete topology snapshots on config or pack-metadata invalidation", async () => {
    const service = new ResourceUniverseService();
    service.registerProvider(providerWith("physical", request =>
      snapshot("physical", request.requestGeneration, [producer("physical", "old-root")])
    ));
    await service.refreshProviderProject("physical", "project");

    service.removeProject("project");

    assert.strictEqual(service.index.getCoverage("physical", "project"), undefined);
    assert.deepStrictEqual(
      service.index.getProducersForKey({ kind: "model", id: "demo:old-root" }),
      []
    );
  });

  it("uses provider-owned document projection policy without requesting a snapshot", () => {
    const service = new ResourceUniverseService();
    const generated = {
      ...producer("rsgl", "generated"),
      origin: "generated" as const,
      sourceOrigins: [{
        uri: "file:///workspace/rsgl/main.rsgl",
        origin: "generated" as const,
        editable: true
      }],
      physicalOrigins: [],
      materializationState: "unbuilt" as const
    };
    let snapshotRequests = 0;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async request => {
        snapshotRequests += 1;
        return snapshot("rsgl", request.requestGeneration, [generated]);
      },
      canHandleDocument: document => document.languageId === "rsgl",
      getDocumentProjection: request => ({
        providerId: "rsgl",
        projectId: request.projectId,
        documentUri: request.document.uri,
        resources: request.producers,
        contributesTo: []
      })
    });
    service.index.replaceSnapshot(snapshot("rsgl", 1, [generated]));
    const document = {
      uri: "file:///workspace/rsgl/main.rsgl",
      fileName: "C:/workspace/rsgl/main.rsgl",
      languageId: "rsgl"
    };

    assert.deepStrictEqual(service.getDocumentProviderIds(document), ["rsgl"]);
    assert.deepStrictEqual(
      service.getDocumentProjections(document, "project")[0].resources.map(item => item.producerId),
      [generated.producerId]
    );
    assert.strictEqual(snapshotRequests, 0);
  });
});

function providerWith(
  providerId: string,
  create: (request: ResourceContributionRequest) => ResourceProviderSnapshot
): ResourceContributionProvider {
  return {
    providerId,
    getSnapshot: async request => create(request)
  };
}

function emptySnapshot(
  providerId: string,
  projectId: string,
  generation: number
): ResourceProviderSnapshot {
  return {
    providerId,
    projectId,
    generation,
    revision: `${providerId}-${generation}`,
    coverage: {
      status: "authoritative",
      revision: `${providerId}-${generation}`,
      coveredScope: { projectId }
    },
    producers: [],
    edges: []
  };
}

function snapshot(
  providerId: string,
  generation: number,
  producers: readonly ResourceProducer[]
): ResourceProviderSnapshot {
  return {
    ...emptySnapshot(providerId, "project", generation),
    producers
  };
}

function producer(providerId: string, id: string): ResourceProducer {
  return {
    producerId: `${providerId}:${id}`,
    providerId,
    projectId: "project",
    layerId: "local",
    layerRole: "local",
    origin: "physical",
    logicalKeys: [{ kind: "model", id: `demo:${id}` }],
    sourceOrigins: [],
    physicalOrigins: [{
      uri: `file:///workspace/assets/demo/models/${id}.json`,
      origin: "physical",
      editable: true
    }],
    materializationState: "handwritten",
    revision: "r1"
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
