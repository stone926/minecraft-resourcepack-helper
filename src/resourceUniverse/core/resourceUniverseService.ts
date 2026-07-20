import type { ResourceGraphLogicalKey } from "../../../packages/mc-assets/src";
import { ResourceContributionRegistry, type ResourceProviderRegistration } from "./resourceContributionRegistry";
import { ResourceUniverseIndex } from "./resourceUniverseIndex";
import type {
  ResourceContributionProvider,
  ResourceCoverageScope,
  ResourceDocumentDescriptor,
  ResourceDocumentProjection,
  ResourceEdge,
  ResourceProducer,
  ResourceProviderSnapshot,
  ResourceProviderUnavailableReason,
  ResourceResolutionContext,
  ResourceResolutionResult
} from "./types";

export interface ResourceUniverseRefreshResult {
  applied: boolean;
  reason?: "staleGeneration";
  snapshots: readonly ResourceProviderSnapshot[];
}

export interface ResourceUniverseChangeEvent {
  kind: "replacement" | "invalidation" | "removal";
  projectId: string;
  providerIds: readonly string[];
}

export interface ResourceUniverseSubscription {
  dispose(): void;
}

interface ProviderProjectRequestState {
  generation: number;
  inFlight?: {
    signature: string;
    generation: number;
    controller: AbortController;
    promise: Promise<ResourceProviderSnapshot>;
  };
}

/**
 * Facade over provider registration, snapshot orchestration, and indexed
 * queries. Work is always requested for an explicit project/scope.
 */
export class ResourceUniverseService {
  private readonly requestStates = new Map<string, ProviderProjectRequestState>();
  private readonly knownProviderProjects = new Set<string>();
  private readonly listeners = new Set<(event: ResourceUniverseChangeEvent) => void>();

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
        const affectedProjects = new Set<string>();
        for (const identity of [...this.knownProviderProjects]) {
          const [providerId, projectId] = splitProviderProjectKey(identity);
          if (providerId !== provider.providerId) {
            continue;
          }
          this.abortRequest(identity);
          this.index.removeProviderProject(providerId, projectId);
          this.knownProviderProjects.delete(identity);
          affectedProjects.add(projectId);
        }
        for (const projectId of affectedProjects) {
          this.emit({ kind: "removal", projectId, providerIds: [provider.providerId] });
        }
      }
    };
  }

  public onDidChange(listener: (event: ResourceUniverseChangeEvent) => void): ResourceUniverseSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async refreshProviderProject(
    providerId: string,
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult> {
    const snapshot = await this.requestSnapshot(providerId, projectId, scope, signal);
    if (!this.isCurrentSnapshot(snapshot)) {
      return { applied: false, reason: "staleGeneration", snapshots: [snapshot] };
    }
    const applied = this.index.replaceSnapshotsAtomically([snapshot]);
    if (applied) {
      this.emit({ kind: "replacement", projectId, providerIds: [providerId] });
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
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult> {
    const snapshots = await Promise.all(providerIds.map(providerId =>
      this.requestSnapshot(providerId, projectId, scope, signal)
    ));
    if (snapshots.some(snapshot => !this.isCurrentSnapshot(snapshot))) {
      return { applied: false, reason: "staleGeneration", snapshots };
    }
    const applied = this.index.replaceSnapshotsAtomically(snapshots);
    if (applied && providerIds.length > 0) {
      this.emit({ kind: "replacement", projectId, providerIds: [...providerIds] });
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
    reason: ResourceProviderUnavailableReason = "stale"
  ): void {
    const key = providerProjectKey(providerId, projectId);
    const state = this.stateFor(key);
    this.abortRequest(key);
    state.generation = Math.max(
      state.generation + 1,
      (this.index.getSnapshotGeneration(providerId, projectId) ?? 0) + 1
    );
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
    this.emit({ kind: "invalidation", projectId, providerIds: [providerId] });
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
    const providerIds = new Set<string>();
    for (const identity of [...this.knownProviderProjects]) {
      const [providerId, candidateProjectId] = splitProviderProjectKey(identity);
      if (candidateProjectId !== projectId) {
        continue;
      }
      this.abortRequest(identity);
      this.index.removeProviderProject(providerId, projectId);
      this.knownProviderProjects.delete(identity);
      providerIds.add(providerId);
    }
    if (providerIds.size > 0) {
      this.emit({ kind: "removal", projectId, providerIds: [...providerIds] });
    }
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
      this.abortRequest(key);
    }
    this.requestStates.clear();
    this.listeners.clear();
  }

  private requestSnapshot(
    providerId: string,
    projectId: string,
    scope: ResourceCoverageScope,
    signal: AbortSignal | undefined
  ): Promise<ResourceProviderSnapshot> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return Promise.reject(new Error(`Unknown resource provider '${providerId}'.`));
    }
    if (scope.projectId !== projectId) {
      return Promise.reject(new Error("Resource coverage scope must belong to the requested project."));
    }

    const key = providerProjectKey(providerId, projectId);
    const signature = coverageScopeSignature(scope);
    const state = this.stateFor(key);
    if (state.inFlight?.signature === signature && !state.inFlight.controller.signal.aborted) {
      if (signal) {
        linkAbortSignal(signal, state.inFlight.controller);
      }
      return state.inFlight.promise;
    }

    this.abortRequest(key);
    const generation = Math.max(
      state.generation + 1,
      (this.index.getSnapshotGeneration(providerId, projectId) ?? 0) + 1
    );
    state.generation = generation;
    const controller = new AbortController();
    const unlink = signal ? linkAbortSignal(signal, controller) : undefined;
    const request = {
      projectId,
      scope,
      knownRevision: this.index.getSnapshotRevision(providerId, projectId),
      requestGeneration: generation
    };
    const promise = provider.getSnapshot(request, controller.signal).then(snapshot => {
      if (snapshot.providerId !== providerId || snapshot.projectId !== projectId) {
        throw new Error(`Provider '${providerId}' returned a snapshot for a different provider/project.`);
      }
      if (snapshot.generation !== generation) {
        throw new Error(
          `Provider '${providerId}' returned generation ${snapshot.generation}; expected ${generation}.`
        );
      }
      return snapshot;
    }).finally(() => {
      unlink?.();
      if (state.inFlight?.promise === promise) {
        state.inFlight = undefined;
      }
    });
    state.inFlight = { signature, generation, controller, promise };
    this.knownProviderProjects.add(key);
    return promise;
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

  private abortRequest(key: string): void {
    const state = this.requestStates.get(key);
    state?.inFlight?.controller.abort();
    if (state) {
      state.inFlight = undefined;
    }
  }

  private emit(event: ResourceUniverseChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function providerProjectKey(providerId: string, projectId: string): string {
  return `${providerId}\0${projectId}`;
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

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
