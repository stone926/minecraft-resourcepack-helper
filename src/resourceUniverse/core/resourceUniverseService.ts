import { providerProjectKey } from "./identity";
import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import { ListenerSet } from "../../../packages/shared-utils/src";
import { abortSignalReason } from "../../utils/abortError";
import { ResourceContributionRegistry, type ResourceProviderRegistration } from "./resourceContributionRegistry";
import { ResourceUniverseIndex } from "./resourceUniverseIndex";
import type {
  ResourceContributionProvider,
  ResourceCoverageScope,
  ResourceDocumentDescriptor,
  ResourceDocumentProjection,
  ResourceEdge,
  ProviderCoverage,
  ResourceProducer,
  ResourceProviderSnapshot,
  ResourceProviderUnavailableReason,
  ResourceResolutionContext,
  ResourceResolutionResult
} from "./types";

export interface ResourceUniverseRefreshResult {
  applied: boolean;
  reason?: "staleGeneration";
  /** Snapshots completed before a service-owned cancellation made the batch stale. */
  snapshots: readonly ResourceProviderSnapshot[];
}

export interface ResourceUniverseChangeEvent {
  kind: "replacement" | "invalidation" | "removal";
  projectId: string;
  providerIds: readonly string[];
  /** Correlates a replacement/invalidation with the operation that requested it. */
  causeId?: symbol;
}

export interface ResourceUniverseSubscription {
  dispose(): void;
}

interface ProviderProjectRequestState {
  generation: number;
  inFlight?: ProviderProjectInFlight;
}

interface ProviderProjectInFlight {
  signature: string;
  controller: AbortController;
  consumers: Map<symbol, SnapshotRequestConsumer>;
  settled: boolean;
  cancelAsStale(): void;
}

interface SnapshotRequestConsumer {
  resolve(result: SnapshotRequestResult): void;
  reject(error: unknown): void;
}

type SnapshotRequestResult =
  | { kind: "snapshot"; snapshot: ResourceProviderSnapshot }
  | { kind: "stale" };

type SnapshotRequestSettlement =
  | { kind: "fulfilled"; result: SnapshotRequestResult }
  | { kind: "rejected"; error: unknown };

const staleSnapshotRequest: SnapshotRequestResult = { kind: "stale" };

/**
 * Facade over provider registration, snapshot orchestration, and indexed
 * queries. Work is always requested for an explicit project/scope.
 */
export class ResourceUniverseService {
  private readonly requestStates = new Map<string, ProviderProjectRequestState>();
  private readonly generationListeners = new Map<string, Set<(generation: number) => void>>();
  private readonly knownProviderProjects = new Set<string>();
  private readonly listeners = new ListenerSet<ResourceUniverseChangeEvent>();

  public constructor(
    public readonly registry = new ResourceContributionRegistry(),
    public readonly index = new ResourceUniverseIndex()
  ) {}

  public registerProvider(provider: ResourceContributionProvider): ResourceProviderRegistration {
    const registration = this.registry.register(provider);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        registration.dispose();
        const removed = this.removeProviderProjects(providerId => providerId === provider.providerId);
        for (const projectId of removed.keys()) {
          this.emit({ kind: "removal", projectId, providerIds: [provider.providerId] });
        }
      }
    };
  }

  public onDidChange(listener: (event: ResourceUniverseChangeEvent) => void): ResourceUniverseSubscription {
    return this.listeners.add(listener);
  }

  public async refreshProviderProject(
    providerId: string,
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<ResourceUniverseRefreshResult> {
    const requestResult = await this.requestSnapshot(providerId, projectId, scope, signal);
    if (requestResult.kind === "stale") {
      return staleRefreshResult([]);
    }
    const snapshot = requestResult.snapshot;
    if (!this.isCurrentSnapshot(snapshot)) {
      return staleRefreshResult([snapshot]);
    }
    const applied = this.index.replaceSnapshotsAtomically([snapshot]);
    if (applied) {
      this.emit({
        kind: "replacement",
        projectId,
        providerIds: [providerId],
        ...(causeId ? { causeId } : {})
      });
    }
    return {
      applied,
      ...(applied ? {} : { reason: "staleGeneration" as const }),
      snapshots: [snapshot]
    };
  }

  /** Fetches all selected providers first, then commits them as one index batch. */
  public async refreshProject(
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    providerIds: readonly string[] = this.registry.list().map(provider => provider.providerId),
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<ResourceUniverseRefreshResult> {
    const batchController = new AbortController();
    const batchDetachReason = Symbol("resource-universe-batch-detach");
    let terminal: "stale" | "error" | undefined;
    let firstError: unknown;
    const unlink = signal ? linkAbortSignal(signal, batchController, reason => {
      if (terminal === undefined) {
        terminal = "error";
        firstError = reason;
      }
    }) : undefined;
    const requests = providerIds.map(providerId => {
      const key = providerProjectKey(providerId, projectId);
      const promise = this.requestSnapshot(providerId, projectId, scope, batchController.signal);
      return {
        key,
        expectedGeneration: this.requestStates.get(key)?.generation,
        promise
      };
    });
    const markStale = (): void => {
      if (terminal !== undefined) {
        return;
      }
      terminal = "stale";
      batchController.abort(batchDetachReason);
    };
    // A provider may finish long before its siblings. Keep its generation
    // leased until the atomic commit so later invalidation can detach the
    // still-pending members of this batch.
    const generationLeases = new Map<string, () => void>();
    for (const request of requests) {
      if (request.expectedGeneration === undefined || generationLeases.has(request.key)) {
        continue;
      }
      generationLeases.set(
        request.key,
        this.watchGeneration(request.key, request.expectedGeneration, markStale)
      );
    }
    let requestResults: readonly SnapshotRequestResult[];
    try {
      requestResults = await Promise.all(requests.map(request =>
        request.promise.then(
          result => {
            if (result.kind === "stale"
              || (result.kind === "snapshot" && !this.isCurrentSnapshot(result.snapshot))) {
              markStale();
            }
            return result;
          },
          error => {
            if (error !== batchDetachReason && terminal === undefined) {
              terminal = "error";
              firstError = error;
              batchController.abort(batchDetachReason);
            }
            return staleSnapshotRequest;
          }
        )
      ));
    } finally {
      for (const release of generationLeases.values()) {
        release();
      }
      unlink?.();
    }
    const snapshots = requestResults.flatMap(result => result.kind === "snapshot" ? [result.snapshot] : []);
    if (terminal === "error") {
      throw firstError;
    }
    if (terminal === "stale" || requestResults.some(result => result.kind === "stale")) {
      return staleRefreshResult(snapshots);
    }
    if (snapshots.some(snapshot => !this.isCurrentSnapshot(snapshot))) {
      return staleRefreshResult(snapshots);
    }
    const applied = this.index.replaceSnapshotsAtomically(snapshots);
    if (applied && providerIds.length > 0) {
      this.emit({
        kind: "replacement",
        projectId,
        providerIds: [...providerIds],
        ...(causeId ? { causeId } : {})
      });
    }
    return {
      applied,
      ...(applied ? {} : { reason: "staleGeneration" as const }),
      snapshots
    };
  }

  public invalidateProviderProject(
    providerId: string,
    projectId: string,
    reason: ResourceProviderUnavailableReason = "stale",
    causeId?: symbol
  ): void {
    const key = providerProjectKey(providerId, projectId);
    const state = this.stateFor(key);
    this.cancelRequest(key);
    this.advanceGeneration(providerId, projectId, state);
    this.knownProviderProjects.add(key);
    this.index.replaceSnapshot({
      providerId,
      projectId,
      generation: state.generation,
      coverage: {
        status: "unavailable",
        reason,
        lastKnownRevision: this.index.getSnapshotRevision(providerId, projectId)
      },
      producers: [],
      edges: []
    });
    this.emit({
      kind: "invalidation",
      projectId,
      providerIds: [providerId],
      ...(causeId ? { causeId } : {})
    });
  }

  public invalidateProject(projectId: string, reason: ResourceProviderUnavailableReason = "stale"): void {
    const providerIds = new Set(this.registry.list().map(provider => provider.providerId));
    for (const identity of this.knownProviderProjects) {
      const [providerId, candidateProjectId] = splitProviderProjectKey(identity);
      if (candidateProjectId === projectId) {
        providerIds.add(providerId);
      }
    }
    for (const providerId of providerIds) {
      this.invalidateProviderProject(providerId, projectId, reason);
    }
  }

  public removeProject(projectId: string): void {
    const removed = this.removeProviderProjects((_, candidateProjectId) => candidateProjectId === projectId);
    const providerIds = removed.get(projectId);
    if (providerIds && providerIds.size > 0) {
      this.emit({ kind: "removal", projectId, providerIds: [...providerIds] });
    }
  }

  /** Cancels, invalidates, and unindexes every matching provider/project pair. */
  private removeProviderProjects(
    matches: (providerId: string, projectId: string) => boolean
  ): Map<string, Set<string>> {
    const removedKnownByProject = new Map<string, Set<string>>();
    const identities = new Set([...this.requestStates.keys(), ...this.knownProviderProjects]);
    for (const identity of identities) {
      const [providerId, projectId] = splitProviderProjectKey(identity);
      if (!matches(providerId, projectId)) {
        continue;
      }
      const wasKnown = this.knownProviderProjects.has(identity);
      const state = this.stateFor(identity);
      this.cancelRequest(identity);
      this.advanceGeneration(providerId, projectId, state);
      this.index.removeProviderProject(providerId, projectId);
      this.knownProviderProjects.delete(identity);
      if (wasKnown) {
        const providers = removedKnownByProject.get(projectId) ?? new Set<string>();
        providers.add(providerId);
        removedKnownByProject.set(projectId, providers);
      }
    }
    return removedKnownByProject;
  }

  public resolve(target: ResourceGraphLogicalKey, context: ResourceResolutionContext): ResourceResolutionResult {
    return this.index.resolve(target, context);
  }

  public getProducer(producerId: string): ResourceProducer | undefined {
    return this.index.getProducer(producerId);
  }

  public getIncoming(target: ResourceGraphLogicalKey): ResourceEdge[] {
    return this.index.getIncoming(target);
  }

  public getOutgoing(producerId: string): ResourceEdge[] {
    return this.index.getOutgoing(producerId);
  }

  public getCoverage(providerId: string, projectId: string): ProviderCoverage | undefined {
    return this.index.getCoverage(providerId, projectId);
  }

  public getProjectProducers(projectId: string): ResourceProducer[] {
    return this.index.getProjectProducers(projectId);
  }

  public getProducersForKey(target: ResourceGraphLogicalKey): ResourceProducer[] {
    return this.index.getProducersForKey(target);
  }

  public hasProvider(providerId: string): boolean {
    return this.registry.get(providerId) !== undefined;
  }

  public getRegisteredProvider(providerId: string): ResourceContributionProvider | undefined {
    return this.registry.get(providerId);
  }

  /** Returns provider ids without requesting snapshots or loading runtimes. */
  public getDocumentProviderIds(document: ResourceDocumentDescriptor): string[] {
    return this.registry.list()
      .filter(provider => provider.canHandleDocument?.(document) === true)
      .map(provider => provider.providerId);
  }

  /** Projects only facts already committed to the Universe index. */
  public getDocumentProjections(
    document: ResourceDocumentDescriptor,
    projectId: string
  ): ResourceDocumentProjection[] {
    return this.registry.list().flatMap(provider => {
      if (!provider.canHandleDocument?.(document) || !provider.getDocumentProjection) {
        return [];
      }
      const projection = provider.getDocumentProjection({
        projectId,
        document,
        producers: this.index.getProviderProjectProducers(provider.providerId, projectId)
      });
      if (projection.providerId !== provider.providerId
        || projection.projectId !== projectId
        || projection.documentUri !== document.uri) {
        throw new Error(`Provider '${provider.providerId}' returned a mismatched document projection.`);
      }
      return [projection];
    });
  }

  public dispose(): void {
    for (const key of this.requestStates.keys()) {
      this.cancelRequest(key);
    }
    this.requestStates.clear();
    this.generationListeners.clear();
    this.knownProviderProjects.clear();
    this.listeners.clear();
  }

  private requestSnapshot(
    providerId: string,
    projectId: string,
    scope: ResourceCoverageScope,
    signal: AbortSignal | undefined
  ): Promise<SnapshotRequestResult> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return Promise.reject(new Error(`Unknown resource provider '${providerId}'.`));
    }
    if (scope.projectId !== projectId) {
      return Promise.reject(new Error("Resource coverage scope must belong to the requested project."));
    }
    if (signal?.aborted) {
      return Promise.reject(abortSignalReason(signal));
    }

    const key = providerProjectKey(providerId, projectId);
    const signature = coverageScopeSignature(scope);
    const state = this.stateFor(key);
    if (state.inFlight?.signature === signature && !state.inFlight.controller.signal.aborted) {
      return this.consumeRequest(key, state.inFlight, signal);
    }

    this.cancelRequest(key);
    const generation = this.advanceGeneration(providerId, projectId, state);
    const controller = new AbortController();
    const request = {
      projectId,
      scope,
      knownRevision: this.index.getSnapshotRevision(providerId, projectId),
      requestGeneration: generation
    };
    let cancelledAsStale = false;
    let resolveStale!: (result: SnapshotRequestResult) => void;
    const stalePromise = new Promise<SnapshotRequestResult>(resolve => {
      resolveStale = resolve;
    });
    const inFlight: ProviderProjectInFlight = {
      signature,
      controller,
      consumers: new Map(),
      settled: false,
      cancelAsStale: () => {
        if (cancelledAsStale || inFlight.settled) {
          return;
        }
        cancelledAsStale = true;
        resolveStale(staleSnapshotRequest);
        controller.abort();
      }
    };
    state.inFlight = inFlight;
    this.knownProviderProjects.add(key);

    let providerPromise: Promise<ResourceProviderSnapshot>;
    try {
      providerPromise = provider.getSnapshot(request, controller.signal);
    } catch (error) {
      providerPromise = Promise.reject(error);
    }
    const providerResult = providerPromise.then(snapshot => {
      if (snapshot.providerId !== providerId || snapshot.projectId !== projectId) {
        throw new Error(`Provider '${providerId}' returned a snapshot for a different provider/project.`);
      }
      if (snapshot.generation !== generation) {
        throw new Error(
          `Provider '${providerId}' returned generation ${snapshot.generation}; expected ${generation}.`
        );
      }
      return { kind: "snapshot" as const, snapshot };
    }).catch(error => {
      if (cancelledAsStale) {
        return staleSnapshotRequest;
      }
      throw error;
    });
    const completion = Promise.race([providerResult, stalePromise]);
    void completion.then(
      result => this.settleRequest(key, inFlight, { kind: "fulfilled", result }),
      error => this.settleRequest(key, inFlight, { kind: "rejected", error })
    );
    return this.consumeRequest(key, inFlight, signal);
  }

  private consumeRequest(
    key: string,
    inFlight: ProviderProjectInFlight,
    signal: AbortSignal | undefined
  ): Promise<SnapshotRequestResult> {
    const consumer = Symbol("resource-universe-consumer");
    return new Promise((resolve, reject) => {
      let completed = false;
      const release = (): void => {
        inFlight.consumers.delete(consumer);
        if (signal) {
          signal.removeEventListener("abort", abort);
        }
      };
      const abort = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        release();
        reject(abortSignalReason(signal!));
        if (inFlight.consumers.size === 0 && !inFlight.settled) {
          this.cancelSpecificRequest(key, inFlight);
        }
      };
      inFlight.consumers.set(consumer, {
        resolve: result => {
          if (completed) {
            return;
          }
          completed = true;
          release();
          resolve(result);
        },
        reject: error => {
          if (completed) {
            return;
          }
          completed = true;
          release();
          reject(error);
        }
      });
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }
    });
  }

  private settleRequest(
    key: string,
    inFlight: ProviderProjectInFlight,
    settlement: SnapshotRequestSettlement
  ): void {
    if (inFlight.settled) {
      return;
    }
    inFlight.settled = true;
    const state = this.requestStates.get(key);
    if (state?.inFlight === inFlight) {
      state.inFlight = undefined;
    }
    const consumers = [...inFlight.consumers.values()];
    inFlight.consumers.clear();
    for (const consumer of consumers) {
      if (settlement.kind === "fulfilled") {
        consumer.resolve(settlement.result);
      } else {
        consumer.reject(settlement.error);
      }
    }
  }

  private isCurrentSnapshot(snapshot: ResourceProviderSnapshot): boolean {
    const state = this.requestStates.get(providerProjectKey(snapshot.providerId, snapshot.projectId));
    return state?.generation === snapshot.generation;
  }

  private stateFor(key: string): ProviderProjectRequestState {
    let state = this.requestStates.get(key);
    if (!state) {
      state = { generation: 0 };
      this.requestStates.set(key, state);
    }
    return state;
  }

  private advanceGeneration(
    providerId: string,
    projectId: string,
    state: ProviderProjectRequestState
  ): number {
    state.generation = Math.max(
      state.generation + 1,
      (this.index.getSnapshotGeneration(providerId, projectId) ?? 0) + 1
    );
    for (const listener of this.generationListeners.get(providerProjectKey(providerId, projectId)) ?? []) {
      listener(state.generation);
    }
    return state.generation;
  }

  private watchGeneration(
    key: string,
    expectedGeneration: number,
    onChanged: () => void
  ): () => void {
    if (this.requestStates.get(key)?.generation !== expectedGeneration) {
      onChanged();
      return () => undefined;
    }
    let listeners = this.generationListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.generationListeners.set(key, listeners);
    }
    const listener = (generation: number): void => {
      if (generation !== expectedGeneration) {
        onChanged();
      }
    };
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0 && this.generationListeners.get(key) === listeners) {
        this.generationListeners.delete(key);
      }
    };
  }

  private cancelRequest(key: string): void {
    const state = this.requestStates.get(key);
    if (state?.inFlight) {
      this.cancelSpecificRequest(key, state.inFlight);
    }
  }

  private cancelSpecificRequest(key: string, inFlight: ProviderProjectInFlight): void {
    inFlight.cancelAsStale();
    const state = this.requestStates.get(key);
    if (state?.inFlight === inFlight) {
      state.inFlight = undefined;
    }
  }

  private emit(event: ResourceUniverseChangeEvent): void {
    this.listeners.emit(event);
  }
}


function splitProviderProjectKey(identity: string): [string, string] {
  const separator = identity.indexOf("\0");
  return [identity.slice(0, separator), identity.slice(separator + 1)];
}

function coverageScopeSignature(scope: ResourceCoverageScope): string {
  return JSON.stringify({
    projectId: scope.projectId,
    resolutionScopes: sorted(scope.resolutionScopes),
    kinds: sorted(scope.kinds),
    namespaces: sorted(scope.namespaces),
    pathPrefixes: sorted(scope.pathPrefixes)
  });
}

function sorted(values: readonly string[] | undefined): readonly string[] | undefined {
  return values ? [...values].sort((left, right) => left.localeCompare(right, "en")) : undefined;
}

function linkAbortSignal(
  signal: AbortSignal,
  controller: AbortController,
  onAbort?: (reason: unknown) => void
): () => void {
  const abort = (): void => {
    const reason = abortSignalReason(signal);
    onAbort?.(reason);
    controller.abort(reason);
  };
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function staleRefreshResult(
  snapshots: readonly ResourceProviderSnapshot[]
): ResourceUniverseRefreshResult {
  return {
    applied: false,
    reason: "staleGeneration",
    snapshots
  };
}
