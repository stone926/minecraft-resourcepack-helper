import * as assert from "node:assert/strict";
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

  it("correlates requested provider changes with their initiating query", async () => {
    const service = new ResourceUniverseService();
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async request =>
        emptySnapshot("rsgl", "project", request.requestGeneration)
    });
    const causeId = Symbol("search-inventory");
    const events: Array<{ kind: string; causeId?: symbol }> = [];
    const subscription = service.onDidChange(event => events.push(event));

    await service.refreshProviderProject(
      "rsgl",
      "project",
      { projectId: "project" },
      undefined,
      causeId
    );
    service.invalidateProviderProject("rsgl", "project", "stale", causeId);

    assert.deepStrictEqual(events.map(event => [event.kind, event.causeId]), [
      ["replacement", causeId],
      ["invalidation", causeId]
    ]);
    subscription.dispose();
  });

  it("returns stale immediately when invalidated work ignores abort", async () => {
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

    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.strictEqual(service.index.getCoverage("rsgl", "project")?.status, "unavailable");

    pending.resolve(emptySnapshot("rsgl", "project", request.requestGeneration));
    await Promise.resolve();
  });

  it("normalizes an abort-aware provider invalidated by the service to a stale result", async () => {
    const service = new ResourceUniverseService();
    let providerSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async (_request, signal) => {
        providerSignal = signal;
        await rejectWhenAborted(signal);
        throw new Error("unreachable");
      }
    });

    const refresh = service.refreshProviderProject("rsgl", "project");
    service.invalidateProviderProject("rsgl", "project");

    assert.strictEqual(providerSignal?.aborted, true);
    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
  });

  it("exposes an in-flight request to synchronous provider invalidation", async () => {
    const service = new ResourceUniverseService();
    let observedAbort = false;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async (_request, signal) => {
        service.invalidateProviderProject("rsgl", "project");
        observedAbort = signal.aborted;
        if (!signal.aborted) {
          throw new Error("synchronous invalidation missed the active request");
        }
        throw signal.reason;
      }
    });

    assert.deepStrictEqual(await service.refreshProviderProject("rsgl", "project"), {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.strictEqual(observedAbort, true);
    assert.strictEqual(service.index.getCoverage("rsgl", "project")?.status, "unavailable");
  });

  it("normalizes a superseded coverage scope to stale without affecting the replacement", async () => {
    const service = new ResourceUniverseService();
    const requests: ResourceContributionRequest[] = [];
    const replacement = deferred<ResourceProviderSnapshot>();
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (request, signal) => {
        requests.push(request);
        if (requests.length === 1) {
          await rejectWhenAborted(signal);
          throw new Error("unreachable");
        }
        return replacement.promise;
      }
    });

    const superseded = service.refreshProviderProject("physical", "project", {
      projectId: "project",
      namespaces: ["first"]
    });
    const current = service.refreshProviderProject("physical", "project", {
      projectId: "project",
      namespaces: ["second"]
    });
    replacement.resolve(emptySnapshot("physical", "project", requests[1].requestGeneration));

    assert.deepStrictEqual(await superseded, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.strictEqual((await current).applied, true);
    assert.strictEqual(requests.length, 2);
  });

  it("cancels only one caller's wait for a shared snapshot request", async () => {
    const service = new ResourceUniverseService();
    const pending = deferred<ResourceProviderSnapshot>();
    const calls: ResourceContributionRequest[] = [];
    let providerSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (request, signal) => {
        calls.push(request);
        providerSignal = signal;
        return pending.promise;
      }
    });
    const cancelledCaller = new AbortController();

    const cancelled = service.refreshProviderProject(
      "physical",
      "project",
      { projectId: "project" },
      cancelledCaller.signal
    );
    const shared = service.refreshProviderProject("physical", "project");
    cancelledCaller.abort();

    await assert.rejects(cancelled, error => isAbortError(error));
    assert.strictEqual(providerSignal?.aborted, false, "another consumer still needs the provider request");
    pending.resolve(emptySnapshot("physical", "project", calls[0].requestGeneration));
    assert.strictEqual((await shared).applied, true);
    assert.strictEqual(calls.length, 1);
  });

  it("aborts the provider after every shared caller cancels and removes their signal listeners", async () => {
    const service = new ResourceUniverseService();
    let providerSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (_request, signal) => {
        providerSignal = signal;
        return new Promise<ResourceProviderSnapshot>(() => undefined);
      }
    });
    const first = trackedAbortController();
    const second = trackedAbortController();

    const firstRefresh = service.refreshProviderProject(
      "physical", "project", { projectId: "project" }, first.controller.signal
    );
    const secondRefresh = service.refreshProviderProject(
      "physical", "project", { projectId: "project" }, second.controller.signal
    );
    assert.deepStrictEqual([first.listenerCount(), second.listenerCount()], [1, 1]);

    first.controller.abort();
    await assert.rejects(firstRefresh, error => isAbortError(error));
    assert.strictEqual(providerSignal?.aborted, false);
    assert.strictEqual(first.listenerCount(), 0);

    second.controller.abort();
    await assert.rejects(secondRefresh, error => isAbortError(error));
    assert.strictEqual(providerSignal?.aborted, true);
    assert.strictEqual(second.listenerCount(), 0);
  });

  it("does not let an abort-ignoring snapshot revive a removed project", async () => {
    const service = new ResourceUniverseService();
    const pending = deferred<ResourceProviderSnapshot>();
    let request: ResourceContributionRequest | undefined;
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async value => {
        request = value;
        return pending.promise;
      }
    });

    const refresh = service.refreshProviderProject("physical", "project");
    service.removeProject("project");
    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.ok(request);
    pending.resolve(snapshot("physical", request.requestGeneration, [producer("physical", "removed")]));
    await Promise.resolve();

    assert.strictEqual(service.index.getCoverage("physical", "project"), undefined);
    assert.deepStrictEqual(service.index.getProducersForKey({ kind: "model", id: "demo:removed" }), []);
  });

  it("does not let an abort-ignoring snapshot revive an unregistered provider", async () => {
    const service = new ResourceUniverseService();
    const pending = deferred<ResourceProviderSnapshot>();
    let request: ResourceContributionRequest | undefined;
    const registration = service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async value => {
        request = value;
        return pending.promise;
      }
    });

    const refresh = service.refreshProviderProject("rsgl", "project");
    registration.dispose();
    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.ok(request);
    pending.resolve(snapshot("rsgl", request.requestGeneration, [producer("rsgl", "removed")]));
    await Promise.resolve();

    assert.strictEqual(service.index.getCoverage("rsgl", "project"), undefined);
    assert.deepStrictEqual(service.index.getProducersForKey({ kind: "model", id: "demo:removed" }), []);
  });

  it("normalizes service disposal to stale for an in-flight refresh", async () => {
    const service = new ResourceUniverseService();
    let providerSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (_request, signal) => {
        providerSignal = signal;
        await rejectWhenAborted(signal);
        throw new Error("unreachable");
      }
    });

    const refresh = service.refreshProviderProject("physical", "project");
    service.dispose();

    assert.strictEqual(providerSignal?.aborted, true);
    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
  });

  it("detaches the rest of a project batch immediately when one provider becomes stale", async () => {
    const service = new ResourceUniverseService();
    let physicalSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async () => new Promise<ResourceProviderSnapshot>(() => undefined)
    });
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (_request, signal) => {
        physicalSignal = signal;
        return new Promise<ResourceProviderSnapshot>(() => undefined);
      }
    });

    const refresh = service.refreshProject(
      "project",
      { projectId: "project" },
      ["rsgl", "physical"]
    );
    service.invalidateProviderProject("rsgl", "project");

    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
    assert.strictEqual(physicalSignal?.aborted, true);
    assert.strictEqual(service.index.getCoverage("physical", "project"), undefined);
    assert.strictEqual(service.index.getCoverage("rsgl", "project")?.status, "unavailable");
  });

  it("keeps completed snapshots leased until a project batch commits", async () => {
    const service = new ResourceUniverseService();
    let rsglRequest: ResourceContributionRequest | undefined;
    let physicalSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async request => {
        rsglRequest = request;
        return emptySnapshot("rsgl", "project", request.requestGeneration);
      }
    });
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (_request, signal) => {
        physicalSignal = signal;
        return new Promise<ResourceProviderSnapshot>(() => undefined);
      }
    });

    const refresh = service.refreshProject(
      "project",
      { projectId: "project" },
      ["rsgl", "physical"]
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(rsglRequest, "the first provider must have completed before invalidation");
    assert.strictEqual(physicalSignal?.aborted, false);

    service.invalidateProviderProject("rsgl", "project");

    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: [emptySnapshot("rsgl", "project", rsglRequest.requestGeneration)]
    });
    assert.strictEqual(physicalSignal?.aborted, true, "the hanging sibling must be detached");
    assert.strictEqual(service.index.getCoverage("physical", "project"), undefined);
    assert.strictEqual(service.index.getCoverage("rsgl", "project")?.status, "unavailable");
  });

  it("preserves external batch cancellation when invalidation follows in the same turn", async () => {
    const service = new ResourceUniverseService();
    for (const providerId of ["rsgl", "physical"]) {
      service.registerProvider({
        providerId,
        getSnapshot: async () => new Promise<ResourceProviderSnapshot>(() => undefined)
      });
    }
    const caller = new AbortController();
    const expected = new Error("caller cancelled batch");
    const refresh = service.refreshProject(
      "project",
      { projectId: "project" },
      ["rsgl", "physical"],
      caller.signal
    );

    caller.abort(expected);
    service.invalidateProviderProject("rsgl", "project");

    await assert.rejects(refresh, error => error === expected);
  });

  it("keeps a service-owned stale result when caller cancellation follows", async () => {
    const service = new ResourceUniverseService();
    for (const providerId of ["rsgl", "physical"]) {
      service.registerProvider({
        providerId,
        getSnapshot: async () => new Promise<ResourceProviderSnapshot>(() => undefined)
      });
    }
    const caller = new AbortController();
    const refresh = service.refreshProject(
      "project",
      { projectId: "project" },
      ["rsgl", "physical"],
      caller.signal
    );

    service.invalidateProviderProject("rsgl", "project");
    caller.abort(new Error("late caller cancellation"));

    assert.deepStrictEqual(await refresh, {
      applied: false,
      reason: "staleGeneration",
      snapshots: []
    });
  });

  it("preserves the first project batch error and releases every remaining consumer", async () => {
    const service = new ResourceUniverseService();
    const expected = new Error("RSGL snapshot failed");
    let physicalSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async () => {
        throw expected;
      }
    });
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (_request, signal) => {
        physicalSignal = signal;
        return new Promise<ResourceProviderSnapshot>(() => undefined);
      }
    });
    const caller = trackedAbortController();

    await assert.rejects(
      service.refreshProject(
        "project",
        { projectId: "project" },
        ["rsgl", "physical"],
        caller.controller.signal
      ),
      error => error === expected
    );

    assert.strictEqual(physicalSignal?.aborted, true);
    assert.strictEqual(caller.listenerCount(), 0);
    assert.strictEqual(service.index.getCoverage("physical", "project"), undefined);
    assert.strictEqual(service.index.getCoverage("rsgl", "project"), undefined);
  });

  it("detaches only the batch consumer when another caller shares its provider request", async () => {
    const service = new ResourceUniverseService();
    const expected = new Error("RSGL snapshot failed");
    const physical = deferred<ResourceProviderSnapshot>();
    let physicalRequest: ResourceContributionRequest | undefined;
    let physicalSignal: AbortSignal | undefined;
    service.registerProvider({
      providerId: "physical",
      getSnapshot: async (request, signal) => {
        physicalRequest = request;
        physicalSignal = signal;
        return physical.promise;
      }
    });
    service.registerProvider({
      providerId: "rsgl",
      getSnapshot: async () => {
        throw expected;
      }
    });
    const shared = service.refreshProviderProject("physical", "project");

    await assert.rejects(
      service.refreshProject(
        "project",
        { projectId: "project" },
        ["physical", "rsgl"]
      ),
      error => error === expected
    );

    assert.strictEqual(physicalSignal?.aborted, false);
    assert.ok(physicalRequest);
    physical.resolve(emptySnapshot("physical", "project", physicalRequest.requestGeneration));
    assert.strictEqual((await shared).applied, true);
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

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function trackedAbortController(): {
  controller: AbortController;
  listenerCount(): number;
} {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const listeners = new Set<Parameters<AbortSignal["addEventListener"]>[1]>();
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    const [type, listener] = args;
    if (type === "abort") {
      listeners.add(listener);
    }
    originalAdd(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    const [type, listener] = args;
    if (type === "abort") {
      listeners.delete(listener);
    }
    originalRemove(...args);
  }) as typeof signal.removeEventListener;
  return { controller, listenerCount: () => listeners.size };
}
