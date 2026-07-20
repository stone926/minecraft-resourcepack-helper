import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import {
  createRsglResourceSnapshotRequest,
  createRsglUnavailableSnapshotResponse,
  PhysicalAssetContributionProvider,
  RsglGeneratedProvider,
  RsglGeneratedProviderConnection,
  ResourceUniverseService,
  type ResourceCoverageScope,
  type ResourceProviderUnavailableReason,
  type ResourceUniverseRefreshResult
} from "../resourceUniverse";
import {
  hydrateRsglMaterializations,
  type RsglMaterializationHydrationHost
} from "./rsglMaterializationHydrator";
import {
  type RsglRuntimeController,
  type RsglRuntimeEnsureOptions,
  type RsglRuntimeInstance,
  type RsglRuntimeLoadReason,
  type RsglRuntimeState
} from "./runtime";

export interface RsglGeneratedProjectContextStore {
  getCachedContext(projectId: string): ResourcePackProjectContextDto | undefined;
  getCachedContexts(): readonly ResourcePackProjectContextDto[];
}

export type RsglGeneratedContributionBridgeOptions = RsglMaterializationHydrationHost;

interface BackgroundRefreshState {
  rerun: boolean;
  promise: Promise<void>;
}

/**
 * Main-owned composition seam between ResourceUniverse and the lazy host. Merely
 * constructing this bridge registers lightweight unavailable coverage; only a
 * project explicitly marked relevant may load the host or start the LSP.
 */
export class RsglGeneratedContributionBridge {
  public readonly provider: RsglGeneratedProvider;
  public readonly connection: RsglGeneratedProviderConnection;

  private readonly relevantProjectIds = new Set<string>();
  private readonly activeSnapshotRequests = new Set<string>();
  private readonly appliedMaterializationTransactions = new Set<string>();
  private readonly backgroundRefreshes = new Map<string, BackgroundRefreshState>();
  private readonly hydrationPromises = new Map<string, Promise<void>>();
  private readonly hydratedContextRevisions = new Map<string, string>();
  private readonly coupledProviderIds: readonly string[];
  private readonly controllerSubscription: { dispose(): void };
  private readonly universeSubscription: { dispose(): void };
  private readonly physicalOwnershipSubscription?: { dispose(): void };
  private boundRuntime?: RsglRuntimeInstance;
  private runtimeInvalidationSubscription?: { dispose(): void };
  private disposed = false;
  private shutdownPromise?: Promise<void>;

  public constructor(
    private readonly projects: RsglGeneratedProjectContextStore,
    private readonly universe: ResourceUniverseService,
    private readonly controller: RsglRuntimeController,
    private readonly options: RsglGeneratedContributionBridgeOptions = {}
  ) {
    this.provider = new RsglGeneratedProvider({
      requestSnapshot: (request, signal) => this.requestSnapshot(request, signal)
    }, {
      localLayerIdForProject: projectId =>
        this.projects.getCachedContext(projectId)?.localLayer.layerId
    });
    this.connection = new RsglGeneratedProviderConnection(universe, this.provider);
    const physicalProvider = universe.registry.get("physical");
    if (physicalProvider instanceof PhysicalAssetContributionProvider) {
      this.physicalOwnershipSubscription = physicalProvider.setOwnedOutputLookup({
        getOwnedOutputPaths: projectId => this.provider.getOwnedOutputPaths(projectId),
        getOwnershipRevision: projectId => this.provider.getOwnershipRevision(projectId)
      });
      this.coupledProviderIds = [physicalProvider.providerId];
    } else {
      this.coupledProviderIds = [];
    }
    this.controllerSubscription = controller.onDidChangeState(state =>
      this.handleRuntimeState(state)
    );
    this.universeSubscription = universe.onDidChange(event => {
      if (event.kind === "removal" && event.providerIds.includes(this.provider.providerId)) {
        this.forgetProject(event.projectId);
      }
    });
  }

  /** Marks a project as an explicit RSGL signal without starting the runtime. */
  public trackProject(projectId: string): boolean {
    this.assertActive();
    const normalizedProjectId = requireIdentity(projectId, "projectId");
    if (!this.projects.getCachedContext(normalizedProjectId)) {
      return false;
    }
    this.relevantProjectIds.add(normalizedProjectId);
    return true;
  }

  /**
   * Starts the two lazy stages separately so host-load and LSP failures retain
   * distinct coverage. The listener is bound before the LSP starts.
   */
  public async ensureLanguageServer(
    projectId: string,
    reason: RsglRuntimeLoadReason,
    options: RsglRuntimeEnsureOptions = {}
  ): Promise<RsglRuntimeInstance | null> {
    this.assertActive();
    if (!this.trackProject(projectId)) {
      return null;
    }
    if (this.controller.getMode() === "off") {
      this.markProjectUnavailable(projectId, "disabled");
      return null;
    }

    let runtime: RsglRuntimeInstance | null;
    try {
      runtime = await this.controller.ensureLoaded(reason, options);
    } catch (error) {
      this.markProjectUnavailable(projectId, "runtimeLoadFailed");
      throw new RsglGeneratedRuntimeError("runtimeLoadFailed", error);
    }
    if (!runtime) {
      this.markProjectUnavailable(projectId, unavailableReasonForState(this.controller.getState()));
      return null;
    }
    this.bindRuntime(runtime);

    if (!runtime.ensureLanguageServer) {
      this.markProjectUnavailable(projectId, "protocolMismatch");
      throw new RsglGeneratedRuntimeError(
        "protocolMismatch",
        new Error("The integrated RSGL runtime does not expose language-server startup.")
      );
    }
    try {
      const readyRuntime = await this.controller.ensureLanguageServer(reason, options);
      if (readyRuntime) {
        this.bindRuntime(readyRuntime);
      }
      return readyRuntime;
    } catch (error) {
      this.markProjectUnavailable(projectId, "lspFailed");
      throw new RsglGeneratedRuntimeError("lspFailed", error);
    }
  }

  /** Explicit graph/navigation refresh. Arbitrary JSON-only Universe refreshes do not call this. */
  public async refreshProject(
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult | undefined> {
    this.assertActive();
    if (!this.trackProject(projectId)) {
      this.universe.invalidateProviderProject(this.provider.providerId, projectId, "notProbed");
      return undefined;
    }
    if (this.controller.getMode() === "off") {
      return this.connection.refreshProject(projectId, scope, signal);
    }
    await this.ensureMaterializations(projectId);
    return this.refreshCoupledProject(projectId, scope, signal);
  }

  /**
   * Applies one ownership-manifest transaction notification. The host callback
   * contains no file contents, so the main-owned reader verifies the committed
   * manifest before replacing materialization facts.
   */
  public async acceptMaterializationInvalidation(
    value: unknown,
    projectIdHint?: string
  ): Promise<boolean> {
    this.assertActive();
    const invalidation = parseMaterializationInvalidation(value);
    if (!invalidation || this.appliedMaterializationTransactions.has(invalidation.transactionId)) {
      return false;
    }
    const context = this.projects.getCachedContext(invalidation.projectId)
      ?? (projectIdHint ? this.projects.getCachedContext(projectIdHint) : undefined);
    if (!context || !this.trackProject(context.projectId)) {
      return false;
    }
    if (invalidation.state === "partial") {
      this.rememberMaterializationTransaction(invalidation.transactionId);
      this.universe.invalidateProviderProject(this.provider.providerId, context.projectId, "stale");
      this.invalidatePhysicalProject(context.projectId);
      return true;
    }
    try {
      const hydrated = await hydrateRsglMaterializations(context, this.options, {
        manifestUri: invalidation.manifestUri,
        projectId: invalidation.projectId,
        ownershipRevision: invalidation.ownershipRevision
      });
      if (!hydrated.expectedManifestVerified) {
        throw new Error("The committed ownership manifest could not be verified.");
      }
      this.provider.replaceMaterializations(hydrated.snapshot);
      this.hydratedContextRevisions.set(context.projectId, context.contextRevision);
      await this.refreshCoupledProject(context.projectId);
      this.rememberMaterializationTransaction(invalidation.transactionId);
      return true;
    } catch {
      this.universe.invalidateProviderProject(this.provider.providerId, context.projectId, "stale");
      this.invalidatePhysicalProject(context.projectId);
      return false;
    }
  }

  /** Used by tests and orderly shutdown to observe coalesced invalidation reloads. */
  public async whenIdle(): Promise<void> {
    while (this.backgroundRefreshes.size > 0 || this.hydrationPromises.size > 0) {
      await Promise.allSettled(
        [
          ...[...this.backgroundRefreshes.values()].map(state => state.promise),
          ...this.hydrationPromises.values()
        ]
      );
    }
  }

  public dispose(): void {
    void this.shutdown();
  }

  public shutdown(): Promise<void> {
    return this.shutdownPromise ??= this.shutdownNow();
  }

  private async requestSnapshot(
    request: Parameters<RsglGeneratedProvider["getSnapshot"]>[0],
    signal: AbortSignal
  ): Promise<unknown> {
    const projectId = request.projectId;
    const context = this.projects.getCachedContext(projectId);
    if (!context || !this.relevantProjectIds.has(projectId)) {
      return createRsglUnavailableSnapshotResponse(request, "notProbed");
    }
    if (this.controller.getMode() === "off") {
      return createRsglUnavailableSnapshotResponse(
        request,
        "disabled",
        this.provider.getProjectState(projectId)?.revision
      );
    }

    this.activeSnapshotRequests.add(projectId);
    try {
      let runtime: RsglRuntimeInstance | null;
      try {
        runtime = await this.ensureLanguageServer(projectId, "graphExpansion");
      } catch (error) {
        const reason = error instanceof RsglGeneratedRuntimeError
          ? error.reason
          : "lspFailed";
        return createRsglUnavailableSnapshotResponse(
          request,
          reason,
          this.provider.getProjectState(projectId)?.revision
        );
      }
      if (signal.aborted) {
        throw abortSignalError(signal);
      }
      if (!runtime) {
        return createRsglUnavailableSnapshotResponse(
          request,
          unavailableReasonForState(this.controller.getState()),
          this.provider.getProjectState(projectId)?.revision
        );
      }
      if (!runtime.requestResourceSnapshot) {
        return createRsglUnavailableSnapshotResponse(
          request,
          "protocolMismatch",
          this.provider.getProjectState(projectId)?.revision
        );
      }
      return await runtime.requestResourceSnapshot(
        createRsglResourceSnapshotRequest(request, context),
        signal
      );
    } catch {
      if (signal.aborted) {
        throw abortSignalError(signal);
      }
      return createRsglUnavailableSnapshotResponse(
        request,
        "lspFailed",
        this.provider.getProjectState(projectId)?.revision
      );
    } finally {
      this.activeSnapshotRequests.delete(projectId);
    }
  }

  private bindRuntime(runtime: RsglRuntimeInstance): void {
    if (this.boundRuntime === runtime) {
      return;
    }
    this.unbindRuntime();
    this.boundRuntime = runtime;
    this.runtimeInvalidationSubscription = runtime.onResourceSnapshotInvalidated?.(value =>
      this.boundRuntime === runtime && this.handleRuntimeInvalidation(value)
    );
  }

  private async ensureMaterializations(projectId: string): Promise<void> {
    const context = this.projects.getCachedContext(projectId);
    if (!context || this.hydratedContextRevisions.get(projectId) === context.contextRevision) {
      return;
    }
    const existing = this.hydrationPromises.get(projectId);
    if (existing) {
      return existing;
    }
    const hydration = (async () => {
      const hydrated = await hydrateRsglMaterializations(context, this.options);
      this.provider.replaceMaterializations(hydrated.snapshot);
      this.hydratedContextRevisions.set(projectId, context.contextRevision);
    })().finally(() => {
      if (this.hydrationPromises.get(projectId) === hydration) {
        this.hydrationPromises.delete(projectId);
      }
    });
    this.hydrationPromises.set(projectId, hydration);
    return hydration;
  }

  private refreshCoupledProject(
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult> {
    return this.universe.refreshProject(
      projectId,
      scope,
      [this.provider.providerId, ...this.coupledProviderIds],
      signal
    );
  }

  private invalidatePhysicalProject(projectId: string): void {
    for (const providerId of this.coupledProviderIds) {
      this.universe.invalidateProviderProject(providerId, projectId, "stale");
    }
  }

  private unbindRuntime(): void {
    this.runtimeInvalidationSubscription?.dispose();
    this.runtimeInvalidationSubscription = undefined;
    this.boundRuntime = undefined;
  }

  private handleRuntimeInvalidation(value: unknown): void {
    if (this.disposed) {
      return;
    }
    const projectId = projectIdFromNotification(value);
    if (!projectId
      || !this.relevantProjectIds.has(projectId)
      || !this.projects.getCachedContext(projectId)) {
      return;
    }
    if (!this.connection.acceptInvalidation(value)) {
      return;
    }
    if (this.controller.getMode() !== "off") {
      this.scheduleBackgroundRefresh(projectId);
    }
  }

  private scheduleBackgroundRefresh(projectId: string): void {
    const existing = this.backgroundRefreshes.get(projectId);
    if (existing) {
      existing.rerun = true;
      return;
    }

    const state = {} as BackgroundRefreshState;
    state.rerun = false;
    state.promise = (async () => {
      do {
        state.rerun = false;
        if (this.disposed
          || this.controller.getMode() === "off"
          || !this.relevantProjectIds.has(projectId)
          || !this.projects.getCachedContext(projectId)) {
          return;
        }
        try {
          await this.connection.refreshProject(projectId);
        } catch (error) {
          if (this.disposed
            || !this.relevantProjectIds.has(projectId)
            || this.controller.getMode() === "off") {
            return;
          }
          if (!isAbortError(error)) {
            this.universe.invalidateProviderProject(
              this.provider.providerId,
              projectId,
              "lspFailed"
            );
          }
        }
      } while (state.rerun);
    })().finally(() => {
      if (this.backgroundRefreshes.get(projectId) === state) {
        this.backgroundRefreshes.delete(projectId);
      }
    });
    this.backgroundRefreshes.set(projectId, state);
  }

  private handleRuntimeState(state: RsglRuntimeState): void {
    if (state.kind !== "ready") {
      this.unbindRuntime();
    }
    const reason = unavailableReasonForRuntimeTransition(state);
    if (!reason) {
      return;
    }
    for (const projectId of this.relevantProjectIds) {
      this.markProjectUnavailable(projectId, reason);
    }
  }

  private markProjectUnavailable(
    projectId: string,
    reason: ResourceProviderUnavailableReason
  ): void {
    if (this.disposed || this.activeSnapshotRequests.has(projectId)) {
      return;
    }
    this.universe.invalidateProviderProject(this.provider.providerId, projectId, reason);
  }

  private forgetProject(projectId: string): void {
    if (this.disposed) {
      return;
    }
    this.relevantProjectIds.delete(projectId);
    this.hydratedContextRevisions.delete(projectId);
    this.hydrationPromises.delete(projectId);
    this.provider.removeProject(projectId);
    const refresh = this.backgroundRefreshes.get(projectId);
    if (refresh) {
      refresh.rerun = false;
    }
    void this.controller.setProjectAvailable(this.projects.getCachedContexts().length > 0);
  }

  private rememberMaterializationTransaction(transactionId: string): void {
    this.appliedMaterializationTransactions.add(transactionId);
    if (this.appliedMaterializationTransactions.size <= 256) {
      return;
    }
    const oldest = this.appliedMaterializationTransactions.values().next().value;
    if (oldest) {
      this.appliedMaterializationTransactions.delete(oldest);
    }
  }

  private async shutdownNow(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controllerSubscription.dispose();
    this.universeSubscription.dispose();
    this.physicalOwnershipSubscription?.dispose();
    this.unbindRuntime();
    this.relevantProjectIds.clear();
    this.connection.dispose();
    await this.whenIdle();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("The RSGL generated contribution bridge has been disposed.");
    }
  }
}

class RsglGeneratedRuntimeError extends Error {
  public constructor(
    public readonly reason: Extract<
      ResourceProviderUnavailableReason,
      "runtimeLoadFailed" | "lspFailed" | "protocolMismatch"
    >,
    cause: unknown
  ) {
    super(`RSGL generated-resource ${reason}: ${errorMessage(cause)}`, { cause });
    this.name = "RsglGeneratedRuntimeError";
  }
}

function unavailableReasonForState(state: RsglRuntimeState): ResourceProviderUnavailableReason {
  if (state.kind === "suspended") {
    return state.reason === "disabled" ? "disabled" : "notProbed";
  }
  if (state.kind === "loading") {
    return "loading";
  }
  if (state.kind === "failed") {
    return "runtimeLoadFailed";
  }
  if (state.kind === "ready") {
    return "lspStarting";
  }
  return state.kind === "disposed" ? "disabled" : "notProbed";
}

function unavailableReasonForRuntimeTransition(
  state: RsglRuntimeState
): ResourceProviderUnavailableReason | undefined {
  if (state.kind === "loading") {
    return "loading";
  }
  if (state.kind === "failed") {
    return "runtimeLoadFailed";
  }
  if (state.kind === "suspended") {
    return state.reason === "disabled" ? "disabled" : "notProbed";
  }
  return state.kind === "idle" ? "notProbed" : undefined;
}

function projectIdFromNotification(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const projectId = (value as { projectId?: unknown }).projectId;
  return typeof projectId === "string" && projectId.trim().length > 0
    ? projectId
    : undefined;
}

interface MaterializationInvalidation {
  transactionId: string;
  projectId: string;
  ownershipRevision: string;
  state: "committed" | "partial";
  manifestUri: string;
}

function parseMaterializationInvalidation(value: unknown): MaterializationInvalidation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1
    || (record.state !== "committed" && record.state !== "partial")
    || !isSerializedUri(record.manifestUri)
    || !isSerializedUriArray(record.changedUris)
    || !isSerializedUriArray(record.deletedUris)) {
    return undefined;
  }
  try {
    return {
      transactionId: requireIdentity(record.transactionId as string, "transactionId"),
      projectId: requireIdentity(record.projectId as string, "projectId"),
      ownershipRevision: requireIdentity(record.ownershipRevision as string, "ownershipRevision"),
      state: record.state,
      manifestUri: record.manifestUri
    };
  } catch {
    return undefined;
  }
}

function isSerializedUriArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isSerializedUri);
}

function isSerializedUri(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.includes("\0");
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty identity.`);
  }
  return value.trim();
}

function abortSignalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The RSGL resource snapshot request was cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
