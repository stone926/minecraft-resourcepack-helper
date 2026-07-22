import * as assert from "node:assert";
import { createHash } from "node:crypto";
import type { ResourcePackProjectContextDto } from "../../../packages/resource-project/src";
import {
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceSnapshotInvalidationNotification,
  type RsglResourceSnapshotRequest,
  type RsglResourceSnapshotResponse
} from "../../../packages/rsgl-shared/src";
import {
  RsglGeneratedContributionBridge,
  type RsglGeneratedProjectContextStore
} from "../../rsgl/rsglGeneratedContributionBridge";
import type {
  BackgroundRefreshTimerHandle,
  BackgroundRefreshTimerHost
} from "../../rsgl/backgroundRefreshScheduler";
import {
  RsglRuntimeController,
  type RsglRuntimeInstance
} from "../../rsgl/runtime";
import {
  PhysicalAssetContributionProvider,
  ResourceUniverseService,
  type PhysicalAssetOwnedOutputLookup,
  type PhysicalAssetProjectScan,
  type PhysicalAssetProjectSource,
  type ResourceContributionRequest
} from "../../resourceUniverse";

describe("RSGL generated contribution bridge", () => {
  it("does not hydrate manifests or load the host while RSGL is off", async () => {
    const context = projectContext();
    let hostLoads = 0;
    let manifestLists = 0;
    const controller = new RsglRuntimeController(async () => {
      hostLoads++;
      return new SnapshotRuntime();
    }, { mode: "off", hasActiveProject: true });
    const universe = new ResourceUniverseService();
    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller,
      { listDirectoryUris: async () => { manifestLists++; return []; } }
    );

    await bridge.refreshProject(context.projectId);

    assert.strictEqual(hostLoads, 0);
    assert.strictEqual(manifestLists, 0);
    assert.strictEqual(
      universe.index.getCoverage("rsgl", context.projectId)?.status,
      "unavailable"
    );
    await bridge.shutdown();
    await controller.dispose();
  });

  it("stays cold for an untracked JSON-only request, then requests and reloads one project", async () => {
    const context = projectContext();
    const projectStore = new ProjectStore(context);
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => {
      host.loads++;
      return host;
    }, { mode: "auto", hasActiveProject: true });
    const universe = new ResourceUniverseService();
    const bridge = new RsglGeneratedContributionBridge(projectStore, universe, controller, {
      backgroundRefreshDelayMs: 0
    });

    assert.deepStrictEqual(universe.registry.list().map(provider => provider.providerId), ["rsgl"]);
    await universe.refreshProviderProject("rsgl", context.projectId);
    assert.strictEqual(host.loads, 0, "a generic JSON-only Universe refresh must not load RSGL");
    assert.deepStrictEqual(universe.index.getCoverage("rsgl", context.projectId), {
      status: "unavailable",
      reason: "notProbed"
    });

    await bridge.refreshProject(context.projectId);
    assert.strictEqual(host.loads, 1);
    assert.strictEqual(host.languageServerStarts, 1);
    assert.strictEqual(host.requests.length, 1);
    assert.deepStrictEqual(host.requests[0], {
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectContext: context,
      scope: { kind: "project", projectId: context.projectId },
      requestGeneration: 2
    });
    assert.strictEqual(universe.index.getCoverage("rsgl", context.projectId)?.status, "authoritative");
    assert.ok(universe.getProducer(producerId));
    assert.strictEqual(
      bridge.provider.getProjectState(context.projectId)?.materializationStatus,
      "missing",
      "a missing manifest is explicit and never inferred from the physical output"
    );

    const staleListener = host.onlyInvalidationListener();
    const invalidation = snapshotInvalidation(context.projectId, "invalidation-r1");
    host.emitInvalidation(invalidation);
    assert.deepStrictEqual(universe.index.getCoverage("rsgl", context.projectId), {
      status: "unavailable",
      reason: "stale",
      lastKnownRevision: "snapshot-r1"
    });
    await bridge.whenIdle();
    assert.strictEqual(host.requests.length, 2);
    assert.strictEqual(universe.index.getCoverage("rsgl", context.projectId)?.status, "authoritative");

    host.emitInvalidation(invalidation);
    await bridge.whenIdle();
    assert.strictEqual(host.requests.length, 2, "duplicate invalidation revisions are coalesced");

    await controller.setMode("off");
    assert.strictEqual(host.invalidationListeners.size, 0);
    assert.strictEqual(host.disposals, 1);
    assert.deepStrictEqual(universe.index.getCoverage("rsgl", context.projectId), {
      status: "unavailable",
      reason: "disabled",
      lastKnownRevision: "snapshot-r1"
    });
    staleListener(snapshotInvalidation(context.projectId, "stale-runtime-r2"));
    await bridge.whenIdle();
    assert.strictEqual(host.requests.length, 2, "a stale runtime listener cannot refresh a newer generation");

    await bridge.shutdown();
    assert.deepStrictEqual(universe.registry.list(), []);
    await controller.dispose();
  });

  it("marks generated facts stale immediately but coalesces edit bursts before rebuilding", async () => {
    const context = projectContext();
    const projectStore = new ProjectStore(context);
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const timer = new BridgeTimerHost();
    const bridge = new RsglGeneratedContributionBridge(projectStore, universe, controller, {
      backgroundRefreshDelayMs: 250,
      backgroundRefreshTimerHost: timer
    });

    await bridge.refreshProject(context.projectId);
    assert.strictEqual(host.requests.length, 1);

    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-r1"));
    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-r2"));
    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-r3"));

    const staleCoverage = universe.index.getCoverage("rsgl", context.projectId);
    assert.strictEqual(staleCoverage?.status, "unavailable");
    assert.strictEqual(staleCoverage?.status === "unavailable" ? staleCoverage.reason : undefined, "stale");
    assert.strictEqual(host.requests.length, 1, "typing must not start a project compile immediately");

    let idle = false;
    const idlePromise = bridge.whenIdle().then(() => { idle = true; });
    timer.advanceBy(249);
    await Promise.resolve();
    assert.strictEqual(idle, false, "pending debounce work is not idle");
    assert.strictEqual(host.requests.length, 1);

    timer.advanceBy(1);
    await idlePromise;
    assert.strictEqual(host.requests.length, 2, "the edit burst produces one project snapshot request");
    assert.strictEqual(universe.index.getCoverage("rsgl", context.projectId)?.status, "authoritative");

    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-r4"));
    await bridge.refreshProject(context.projectId);
    assert.strictEqual(host.requests.length, 3, "an explicit refresh bypasses the background delay");
    timer.advanceBy(1_000);
    await bridge.whenIdle();
    assert.strictEqual(host.requests.length, 3, "the explicit refresh cancels its pending background duplicate");

    await bridge.shutdown();
    await controller.dispose();
  });

  it("restores a pending invalidation refresh when its foreground replacement fails", async () => {
    const context = projectContext();
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const physicalSource = new FailingPhysicalSource(context);
    const physicalRegistration = universe.registerProvider(
      new PhysicalAssetContributionProvider(physicalSource)
    );
    const timer = new BridgeTimerHost();
    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller,
      {
        backgroundRefreshDelayMs: 250,
        backgroundRefreshTimerHost: timer
      }
    );

    await bridge.refreshProject(context.projectId);
    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-before-failure"));
    physicalSource.failNextScan = true;

    await assert.rejects(
      bridge.refreshProject(context.projectId),
      /synthetic physical refresh failure/
    );
    assert.strictEqual(host.requests.length, 2);
    assert.strictEqual(universe.index.getCoverage("rsgl", context.projectId)?.status, "unavailable");

    timer.advanceBy(250);
    await bridge.whenIdle();

    assert.strictEqual(host.requests.length, 3, "the failed foreground replacement restores pending work");
    assert.strictEqual(universe.index.getCoverage("rsgl", context.projectId)?.status, "authoritative");

    await bridge.shutdown();
    physicalRegistration.dispose();
    await controller.dispose();
  });

  it("aborts an active background snapshot before waiting for shutdown", async () => {
    const context = projectContext();
    const host = new BlockingSnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const timer = new BridgeTimerHost();
    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller,
      {
        backgroundRefreshDelayMs: 0,
        backgroundRefreshTimerHost: timer
      }
    );

    await bridge.refreshProject(context.projectId);
    host.emitInvalidation(snapshotInvalidation(context.projectId, "edit-before-shutdown"));
    timer.advanceBy(0);
    await host.blockedRequestStarted.promise;

    const shutdownPromise = bridge.shutdown();
    await settleAsyncWork();
    const abortedBeforeRelease = host.blockedRequestAborted;
    if (!abortedBeforeRelease) {
      host.releaseBlockedRequest();
    }
    await shutdownPromise;

    assert.strictEqual(
      abortedBeforeRelease,
      true,
      "disposing the provider connection must abort the snapshot before shutdown waits for it"
    );
    await controller.dispose();
  });

  it("hydrates and hashes ownership before one atomic generated/physical replacement", async () => {
    const context = projectContext();
    const projectStore = new ProjectStore(context);
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const physicalSource = new OwnershipAwarePhysicalSource(context);
    const physicalRegistration = universe.registerProvider(
      new PhysicalAssetContributionProvider(physicalSource)
    );
    const manifestUri = `${context.outputPackRootUri}/.rsgl/manifests/project.json`;
    const expectedBytes = Buffer.from("generated model");
    const editedBytes = Buffer.from("user edited generated model");
    let manifestReads = 0;
    const bridge = new RsglGeneratedContributionBridge(projectStore, universe, controller, {
      listDirectoryUris: async () => [manifestUri],
      readTextUri: async () => {
        manifestReads++;
        return ownershipManifest(context, hashBytes(expectedBytes));
      },
      readBinaryUri: async uri => uri.endsWith(outputPath) ? editedBytes : undefined
    });
    const replacements: string[][] = [];
    const subscription = universe.onDidChange(event => {
      if (event.kind === "replacement") {
        replacements.push([...event.providerIds]);
      }
    });

    await bridge.refreshProject(context.projectId);

    assert.strictEqual(manifestReads, 1, "the first relevant refresh hydrates manifests once");
    assert.strictEqual(
      universe.getProducer(producerId)?.materializationState,
      "conflict",
      "the actual output hash, not path equality, detects an edited generated file"
    );
    assert.deepStrictEqual(
      universe.index.getProviderProjectProducers("physical", context.projectId),
      [],
      "ownership-proven output is not registered as a second handwritten producer"
    );
    assert.deepStrictEqual(replacements, [["rsgl", "physical"]]);
    assert.deepStrictEqual([...physicalSource.lastOwnedOutputPaths], [outputPath]);
    assert.ok(physicalSource.lastOwnershipRevision?.startsWith("sha256:"));
    assert.strictEqual(
      bridge.provider.getProjectState(context.projectId)?.materializationStatus,
      "authoritative"
    );

    subscription.dispose();
    await bridge.shutdown();
    physicalRegistration.dispose();
    await controller.dispose();
  });

  it("binds physical ownership through a structural provider from another class identity", async () => {
    const context = projectContext();
    const controller = new RsglRuntimeController(async () => new SnapshotRuntime(), {
      mode: "off",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const physicalProvider = new CrossBundlePhysicalProvider();
    assert.strictEqual(
      physicalProvider instanceof PhysicalAssetContributionProvider,
      false,
      "the test provider deliberately has no shared constructor identity"
    );
    const physicalRegistration = universe.registerProvider(physicalProvider);

    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller
    );

    assert.strictEqual(physicalProvider.bindings, 1);
    assert.ok(physicalProvider.lookup);
    assert.deepStrictEqual(
      [...physicalProvider.lookup.getOwnedOutputPaths(context.projectId)],
      []
    );
    await bridge.shutdown();
    assert.strictEqual(physicalProvider.disposals, 1);

    physicalRegistration.dispose();
    await controller.dispose();
  });

  it("safely skips a physical provider without the ownership capability", async () => {
    const context = projectContext();
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    let physicalRequests = 0;
    const physicalRegistration = universe.registerProvider({
      providerId: "physical",
      getSnapshot: async () => {
        physicalRequests++;
        throw new Error("a provider without ownership must not be coupled");
      }
    });
    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller
    );

    await bridge.refreshProject(context.projectId);

    assert.strictEqual(physicalRequests, 0);
    assert.strictEqual(
      universe.index.getCoverage("rsgl", context.projectId)?.status,
      "authoritative"
    );
    await bridge.shutdown();
    physicalRegistration.dispose();
    await controller.dispose();
  });

  it("keeps initializing when a structural ownership provider rejects binding", async () => {
    const context = projectContext();
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const physicalProvider = new ThrowingOwnershipPhysicalProvider();
    const physicalRegistration = universe.registerProvider(physicalProvider);

    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller
    );
    await bridge.refreshProject(context.projectId);

    assert.strictEqual(physicalProvider.bindingAttempts, 1);
    assert.strictEqual(physicalProvider.snapshotRequests, 0);
    assert.strictEqual(
      universe.index.getCoverage("rsgl", context.projectId)?.status,
      "authoritative"
    );
    await bridge.shutdown();
    physicalRegistration.dispose();
    await controller.dispose();
  });

  it("reports malformed persisted ownership as partial without inferring paths", async () => {
    const context = projectContext();
    const controller = new RsglRuntimeController(async () => new SnapshotRuntime(), {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    const manifestUri = `${context.outputPackRootUri}/.rsgl/manifests/broken.json`;
    const bridge = new RsglGeneratedContributionBridge(
      new ProjectStore(context),
      universe,
      controller,
      {
        listDirectoryUris: async () => [manifestUri],
        readTextUri: async () => "{ broken"
      }
    );

    await bridge.refreshProject(context.projectId);

    const state = bridge.provider.getProjectState(context.projectId);
    assert.strictEqual(state?.materializationStatus, "partial");
    assert.ok((state?.materializationIssues?.length ?? 0) > 0);
    assert.deepStrictEqual([...bridge.provider.getOwnedOutputPaths(context.projectId)], []);

    await bridge.shutdown();
    await controller.dispose();
  });

  it("reads one committed ownership manifest and reprojects materialization facts once", async () => {
    const context = projectContext();
    const projectStore = new ProjectStore(context);
    const host = new SnapshotRuntime();
    const controller = new RsglRuntimeController(async () => host, {
      mode: "auto",
      hasActiveProject: true
    });
    const universe = new ResourceUniverseService();
    let manifestReads = 0;
    const materializedBytes = Buffer.from("generated model");
    const bridge = new RsglGeneratedContributionBridge(projectStore, universe, controller, {
      readTextUri: async () => {
        manifestReads++;
        return JSON.stringify({
          version: 2,
          projectId: context.projectId,
          sourceRoot: "rsgl",
          outputPackRootIdentity: context.localLayer.layerId,
          buildRevision: "ownership-r1",
          files: [{
            outputPath,
            producerId,
            kind: "model",
            logicalKeys: [{ kind: "model", id: "demo:block/generated" }],
            contentHash: hashBytes(materializedBytes),
            sourceOrigins: []
          }]
        });
      },
      readBinaryUri: async uri => uri.endsWith(outputPath) ? materializedBytes : undefined
    });
    await bridge.refreshProject(context.projectId);

    const invalidation = {
      version: 1,
      transactionId: "transaction-r1",
      projectId: context.projectId,
      ownershipRevision: "ownership-r1",
      state: "committed",
      changedUris: [`${context.outputPackRootUri}/${outputPath}`],
      deletedUris: [],
      manifestUri: `${context.outputPackRootUri}/.rsgl/manifests/project.json`
    } as const;
    assert.strictEqual(await bridge.acceptMaterializationInvalidation(invalidation), true);
    assert.strictEqual(manifestReads, 1);
    assert.strictEqual(universe.getProducer(producerId)?.materializationState, "current");
    assert.deepStrictEqual(universe.getProducer(producerId)?.physicalOrigins, [{
      uri: `${context.outputPackRootUri}/${outputPath}`,
      origin: "materialized",
      editable: true
    }]);

    assert.strictEqual(await bridge.acceptMaterializationInvalidation(invalidation), false);
    assert.strictEqual(manifestReads, 1, "the same committed transaction is applied once");
    await bridge.shutdown();
    await controller.dispose();
  });
});

const producerId = "rsgl:project:generated";
const outputPath = "assets/demo/models/block/generated.json";

class ProjectStore implements RsglGeneratedProjectContextStore {
  public constructor(private readonly context: ResourcePackProjectContextDto) {}

  public getCachedContext(projectId: string): ResourcePackProjectContextDto | undefined {
    return projectId === this.context.projectId ? this.context : undefined;
  }

  public getCachedContexts(): readonly ResourcePackProjectContextDto[] {
    return [this.context];
  }
}

class SnapshotRuntime implements RsglRuntimeInstance {
  public loads = 0;
  public languageServerStarts = 0;
  public disposals = 0;
  public readonly requests: RsglResourceSnapshotRequest[] = [];
  public readonly invalidationListeners = new Set<(value: unknown) => void>();

  public async ensureLanguageServer(): Promise<void> {
    this.languageServerStarts++;
  }

  public async requestResourceSnapshot(value: unknown, signal: AbortSignal): Promise<unknown> {
    void signal;
    const request = value as RsglResourceSnapshotRequest;
    this.requests.push(request);
    if (request.knownRevision === "snapshot-r1") {
      return notModifiedResponse(request);
    }
    return snapshotResponse(request);
  }

  public onResourceSnapshotInvalidated(listener: (value: unknown) => void): { dispose(): void } {
    this.invalidationListeners.add(listener);
    return { dispose: () => this.invalidationListeners.delete(listener) };
  }

  public emitInvalidation(value: unknown): void {
    for (const listener of this.invalidationListeners) {
      listener(value);
    }
  }

  public onlyInvalidationListener(): (value: unknown) => void {
    assert.strictEqual(this.invalidationListeners.size, 1);
    return [...this.invalidationListeners][0];
  }

  public dispose(): void {
    this.disposals++;
  }
}

class BlockingSnapshotRuntime extends SnapshotRuntime {
  public readonly blockedRequestStarted = deferred<void>();
  public blockedRequestAborted = false;
  private releaseBlocked?: () => void;

  public override async requestResourceSnapshot(
    value: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const request = value as RsglResourceSnapshotRequest;
    this.requests.push(request);
    if (this.requests.length === 1) {
      return snapshotResponse(request);
    }

    const blocked = new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        this.blockedRequestAborted = true;
        reject(new Error("snapshot aborted"));
      };
      this.releaseBlocked = () => {
        signal.removeEventListener("abort", abort);
        resolve(snapshotResponse(request));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    this.blockedRequestStarted.resolve();
    return blocked;
  }

  public releaseBlockedRequest(): void {
    this.releaseBlocked?.();
  }
}

class BridgeTimerHost implements BackgroundRefreshTimerHost {
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
  private now = 0;
  private nextHandle = 1;

  public set(callback: () => void, delayMs: number): BackgroundRefreshTimerHandle {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.now + delayMs, callback });
    return handle as unknown as BackgroundRefreshTimerHandle;
  }

  public clear(handle: BackgroundRefreshTimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  public advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.now = timer.dueAt;
      timer.callback();
    }
    this.now = target;
  }
}

function snapshotResponse(request: RsglResourceSnapshotRequest): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: request.projectContext.projectId,
    requestGeneration: request.requestGeneration,
    revision: "snapshot-r1",
    status: "ok",
    coverage: {
      status: "authoritative",
      revision: "snapshot-r1",
      coveredScope: { projectId: request.projectContext.projectId }
    },
    resources: [{
      producerId,
      kind: "model",
      logicalKeys: [{ kind: "model", id: "demo:block/generated" }],
      outputPath,
      sourceOrigins: [{ uri: "file:///workspace/pack/rsgl/main.rsgl" }],
      revision: "producer-r1"
    }],
    edges: []
  };
}

function notModifiedResponse(request: RsglResourceSnapshotRequest): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: request.projectContext.projectId,
    requestGeneration: request.requestGeneration,
    revision: "snapshot-r1",
    status: "notModified",
    coverage: {
      status: "authoritative",
      revision: "snapshot-r1",
      coveredScope: { projectId: request.projectContext.projectId }
    }
  };
}

function snapshotInvalidation(
  projectId: string,
  invalidationRevision: string
): RsglResourceSnapshotInvalidationNotification {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId,
    invalidationRevision,
    reason: "document"
  };
}

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
    configurationRevision: "configuration-r1",
    contextRevision: "context-r1"
  };
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function ownershipManifest(context: ResourcePackProjectContextDto, contentHash: string): string {
  return JSON.stringify({
    version: 2,
    projectId: context.projectId,
    sourceRoot: "rsgl",
    outputPackRootIdentity: context.localLayer.layerId,
    buildRevision: "ownership-r1",
    files: [{
      outputPath,
      producerId,
      kind: "model",
      logicalKeys: [{ kind: "model", id: "demo:block/generated" }],
      contentHash,
      sourceOrigins: []
    }]
  });
}

class OwnershipAwarePhysicalSource implements PhysicalAssetProjectSource {
  public lastOwnedOutputPaths: ReadonlySet<string> = new Set();
  public lastOwnershipRevision: string | undefined;
  private lookup?: PhysicalAssetOwnedOutputLookup;

  public constructor(private readonly context: ResourcePackProjectContextDto) {}

  public setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void } {
    this.lookup = lookup;
    return { dispose: () => this.lookup === lookup && (this.lookup = undefined) };
  }

  public async scanProject(request: ResourceContributionRequest): Promise<PhysicalAssetProjectScan> {
    this.lastOwnedOutputPaths = this.lookup?.getOwnedOutputPaths(request.projectId) ?? new Set();
    this.lastOwnershipRevision = this.lookup?.getOwnershipRevision(request.projectId);
    return {
      revision: `physical:${this.lastOwnershipRevision ?? "none"}`,
      ownedOutputPaths: this.lastOwnedOutputPaths,
      documents: [{
        uri: `${this.context.outputPackRootUri}/${outputPath}`,
        fileName: outputPath,
        languageId: "json",
        revision: "physical-document-r1",
        layerId: this.context.localLayer.layerId,
        layerRole: "local",
        outputPath,
        getText: () => "{}"
      }]
    };
  }
}

class FailingPhysicalSource extends OwnershipAwarePhysicalSource {
  public failNextScan = false;

  public override async scanProject(
    request: ResourceContributionRequest
  ): Promise<PhysicalAssetProjectScan> {
    if (this.failNextScan) {
      this.failNextScan = false;
      throw new Error("synthetic physical refresh failure");
    }
    return super.scanProject(request);
  }
}

class CrossBundlePhysicalProvider {
  public readonly providerId = "physical";
  public bindings = 0;
  public disposals = 0;
  public lookup?: PhysicalAssetOwnedOutputLookup;

  public setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void } {
    this.bindings++;
    this.lookup = lookup;
    return {
      dispose: () => {
        if (this.lookup === lookup) {
          this.lookup = undefined;
          this.disposals++;
        }
      }
    };
  }

  public async getSnapshot(): Promise<never> {
    throw new Error("not used by this focused capability test");
  }
}

class ThrowingOwnershipPhysicalProvider {
  public readonly providerId = "physical";
  public bindingAttempts = 0;
  public snapshotRequests = 0;

  public setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void } {
    void lookup;
    this.bindingAttempts++;
    throw new Error("foreign ownership binding failed");
  }

  public async getSnapshot(): Promise<never> {
    this.snapshotRequests++;
    throw new Error("a failed ownership binding must not be coupled");
  }
}
