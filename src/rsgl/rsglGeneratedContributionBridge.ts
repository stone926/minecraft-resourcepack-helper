import { requireIdentity } from "../resourceUniverse/core/identity";
import { errorMessage } from "../../packages/shared-utils/src";
import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type {
  ResourceCoverageScope,
  ResourceProviderUnavailableReason
} from "../resourceUniverse/core/types";
import type {
  ResourceUniverseRefreshResult,
  ResourceUniverseService
} from "../resourceUniverse/core/resourceUniverseService";
import { RsglGeneratedProvider } from "./provider/rsglGeneratedProvider";
import { RsglGeneratedProviderConnection } from "./provider/rsglGeneratedProviderConnection";
import {
  hydrateRsglMaterializations,
  type RsglMaterializationHydrationHost
} from "./rsglMaterializationHydrator";
import {
  BackgroundRefreshScheduler,
  type BackgroundRefreshTimerHost
} from "./backgroundRefreshScheduler";
import { asDisposable, isAbortError } from "../../packages/shared-utils/src";
import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import {
  parseRsglMaterializationInvalidation,
  type RsglMaterializationInvalidationDto
} from "../../packages/rsgl-shared/src";
import {
  type RsglRuntimeController,
  type RsglRuntimeEnsureOptions,
  type RsglRuntimeInstance,
  type RsglRuntimeLoadReason,
  type RsglRuntimeState
} from "./runtime";
import { bindRsglPhysicalOwnership } from "./rsglOwnershipBinding";
import { RsglSnapshotRequestGate } from "./rsglSnapshotRequestGate";

export interface RsglGeneratedProjectContextStore {
  getCachedContext(projectId: string): ResourcePackProjectContextDto | undefined;
  getCachedContexts(): readonly ResourcePackProjectContextDto[];
}

export interface RsglGeneratedContributionBridgeOptions extends RsglMaterializationHydrationHost {
  /** Quiet period before invalidation-driven project snapshots are rebuilt. */
  backgroundRefreshDelayMs?: number;
  /** Injectable timer boundary for deterministic scheduling tests. */
  backgroundRefreshTimerHost?: BackgroundRefreshTimerHost;
}

/**
 * Main-owned composition seam between ResourceUniverse and the lazy host. Merely
 * constructing this bridge registers lightweight unavailable coverage; only a
 * project explicitly marked relevant may load the host or start the LSP.
 */
export class RsglGeneratedContributionBridge {
  private readonly shutdownDisposable = asDisposable(
    () => this.shutdownNow(),
    error => console.error("Failed to shut down the RSGL generated-resource bridge.", error)
  );
  public readonly provider: RsglGeneratedProvider;
  public readonly connection: RsglGeneratedProviderConnection;

  private readonly snapshotRequestGate: RsglSnapshotRequestGate;
  private readonly backgroundRefreshScheduler: BackgroundRefreshScheduler<string>;
  private readonly physicalRefreshScheduler: BackgroundRefreshScheduler<string>;
  private readonly physicalRefreshControllers = new Map<string, AbortController>();
  private readonly coupledProviderIds: readonly string[];
  private readonly controllerSubscription: { dispose(): void };
  private readonly universeSubscription: { dispose(): void };
  private readonly physicalOwnershipSubscription?: { dispose(): void };
  private boundRuntime?: RsglRuntimeInstance;
  private runtimeInvalidationSubscription?: { dispose(): void };
  private disposed = false;

  public constructor(
    private readonly projects: RsglGeneratedProjectContextStore,
    private readonly universe: ResourceUniverseService,
    private readonly controller: RsglRuntimeController,
    private readonly options: RsglGeneratedContributionBridgeOptions = {}
  ) {
    this.snapshotRequestGate = new RsglSnapshotRequestGate({
      getProjectContext: projectId => this.projects.getCachedContext(projectId),
      isRuntimeDisabled: () => this.controller.getMode() === "off",
      ensureLanguageServer: projectId =>
        this.ensureLanguageServer(projectId, "graphExpansion"),
      getRuntimeUnavailableReason: () => unavailableReasonFor(this.controller.getState(), "query"),
      getLanguageServerFailureReason: error => error instanceof RsglGeneratedRuntimeError
        ? error.reason
        : "lspFailed",
      getLastKnownRevision: projectId => this.provider.getProjectState(projectId)?.revision
    });
    this.provider = new RsglGeneratedProvider({
      requestSnapshot: (request, signal) =>
        this.snapshotRequestGate.requestSnapshot(request, signal)
    }, {
      localLayerIdForProject: projectId =>
        this.projects.getCachedContext(projectId)?.localLayer.layerId
    });
    this.connection = new RsglGeneratedProviderConnection(universe, this.provider);
    this.backgroundRefreshScheduler = new BackgroundRefreshScheduler({
      delayMs: options.backgroundRefreshDelayMs,
      timerHost: options.backgroundRefreshTimerHost,
      run: projectId => this.runBackgroundRefresh(projectId)
    });
    this.physicalRefreshScheduler = new BackgroundRefreshScheduler({
      delayMs: options.backgroundRefreshDelayMs,
      timerHost: options.backgroundRefreshTimerHost,
      run: projectId => this.runPhysicalRefresh(projectId)
    });
    const physicalOwnership = bindRsglPhysicalOwnership(
      universe.getRegisteredProvider(physicalProviderId),
      {
        getOwnedOutputPaths: projectId => this.provider.getOwnedOutputPaths(projectId),
        getOwnershipRevision: projectId => this.provider.getOwnershipRevision(projectId)
      }
    );
    this.physicalOwnershipSubscription = physicalOwnership?.subscription;
    this.coupledProviderIds = physicalOwnership ? [physicalOwnership.providerId] : [];
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
    this.snapshotRequestGate.trackProject(normalizedProjectId);
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
      this.markProjectUnavailable(projectId, unavailableReasonFor(this.controller.getState(), "query"));
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
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<ResourceUniverseRefreshResult | undefined> {
    this.assertActive();
    if (!this.trackProject(projectId)) {
      this.universe.invalidateProviderProject(
        this.provider.providerId,
        projectId,
        "notProbed",
        causeId
      );
      return undefined;
    }
    const restorePendingRefresh = this.backgroundRefreshScheduler.cancel(projectId);
    let replacementApplied = false;
    try {
      let result: ResourceUniverseRefreshResult;
      if (this.controller.getMode() === "off") {
        result = await this.connection.refreshProject(projectId, scope, signal, causeId);
      } else {
        await this.ensureMaterializations(projectId);
        result = await this.refreshCoupledProject(projectId, scope, signal, causeId);
      }
      replacementApplied = result.applied;
      return result;
    } catch (error) {
      // Runtime invalidation deliberately cancels the now-stale foreground
      // snapshot and schedules its replacement. It is not a refresh failure.
      if (signal?.aborted || isAbortError(error)) {
        return undefined;
      }
      throw error;
    } finally {
      if (restorePendingRefresh && !replacementApplied) {
        this.backgroundRefreshScheduler.schedule(projectId);
      }
    }
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
    const invalidation = parseRsglMaterializationInvalidation(value);
    if (!invalidation
      || this.snapshotRequestGate.hasMaterializationTransaction(invalidation.transactionId)) {
      return false;
    }
    const context = this.projects.getCachedContext(invalidation.projectId)
      ?? (projectIdHint ? this.projects.getCachedContext(projectIdHint) : undefined);
    if (!context || !this.trackProject(context.projectId)) {
      return false;
    }
    if (invalidation.state === "partial") {
      this.snapshotRequestGate.rememberMaterializationTransaction(invalidation.transactionId);
      this.universe.invalidateProviderProject(this.provider.providerId, context.projectId, "stale");
      this.invalidatePhysicalProject(context.projectId);
      return true;
    }
    return this.snapshotRequestGate.trackMaterializationApplication(
      invalidation.transactionId,
      this.applyCommittedMaterializationInvalidation(invalidation, context)
    );
  }

  /** Used by tests and orderly shutdown to observe coalesced invalidation reloads. */
  public async whenIdle(): Promise<void> {
    await Promise.all([
      this.snapshotRequestGate.whenIdle(),
      this.backgroundRefreshScheduler.whenIdle(),
      this.physicalRefreshScheduler.whenIdle()
    ]);
    // A committed application can enqueue its physical refresh while the
    // first scheduler wait is already resolving.
    await Promise.all([
      this.backgroundRefreshScheduler.whenIdle(),
      this.physicalRefreshScheduler.whenIdle()
    ]);
  }

  public dispose(): void {
    this.shutdownDisposable.dispose();
  }

  public shutdown(): Promise<void> {
    return this.shutdownDisposable.shutdown();
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
    if (!context) {
      return;
    }
    return this.snapshotRequestGate.ensureHydrated(
      projectId,
      context.contextRevision,
      () => hydrateRsglMaterializations(context, this.options),
      hydrated => {
        if (!this.isCurrentTrackedContext(context)) {
          return false;
        }
        this.provider.replaceMaterializations(hydrated.snapshot);
        return true;
      }
    );
  }

  private async applyCommittedMaterializationInvalidation(
    invalidation: RsglMaterializationInvalidationDto,
    context: ResourcePackProjectContextDto
  ): Promise<boolean> {
    try {
      const hydrated = await hydrateRsglMaterializations(context, this.options, {
        manifestUri: invalidation.manifestUri,
        projectId: invalidation.projectId,
        ownershipRevision: invalidation.ownershipRevision
      });
      if (!this.isCurrentTrackedContext(context)) {
        return false;
      }
      if (!hydrated.expectedManifestVerified) {
        throw new Error("The committed ownership manifest could not be verified.");
      }
      this.provider.replaceMaterializations(hydrated.snapshot);
      this.snapshotRequestGate.markHydrated(context.projectId, context.contextRevision);
      this.invalidatePhysicalProject(context.projectId);
      this.backgroundRefreshScheduler.cancel(context.projectId);
      await this.connection.refreshProject(context.projectId);
      if (!this.isCurrentTrackedContext(context)) {
        return false;
      }
      if (this.coupledProviderIds.length > 0) {
        this.physicalRefreshScheduler.schedule(context.projectId, 0);
      }
      this.snapshotRequestGate.rememberMaterializationTransaction(invalidation.transactionId);
      return true;
    } catch {
      if (this.isCurrentTrackedContext(context)) {
        this.universe.invalidateProviderProject(
          this.provider.providerId,
          context.projectId,
          "stale"
        );
        this.invalidatePhysicalProject(context.projectId);
      }
      return false;
    }
  }

  private refreshCoupledProject(
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<ResourceUniverseRefreshResult> {
    return this.universe.refreshProject(
      projectId,
      scope,
      [this.provider.providerId, ...this.coupledProviderIds],
      signal,
      causeId
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
      || !this.snapshotRequestGate.isProjectTracked(projectId)
      || !this.projects.getCachedContext(projectId)) {
      return;
    }
    if (!this.connection.acceptInvalidation(value)) {
      return;
    }
    if (this.controller.getMode() !== "off") {
      this.scheduleBackgroundRefresh(projectId, invalidationReasonFromNotification(value));
    }
  }

  private scheduleBackgroundRefresh(
    projectId: string,
    reason: string | undefined
  ): void {
    this.backgroundRefreshScheduler.schedule(
      projectId,
      reason === "document" ? undefined : 0
    );
  }

  private async runBackgroundRefresh(projectId: string): Promise<void> {
    if (this.disposed
      || this.controller.getMode() === "off"
      || !this.snapshotRequestGate.isProjectTracked(projectId)
      || !this.projects.getCachedContext(projectId)) {
      return;
    }
    if (this.snapshotRequestGate.hasActiveSnapshotRequest(projectId)) {
      this.backgroundRefreshScheduler.schedule(projectId);
      return;
    }
    try {
      await this.connection.refreshProject(projectId);
    } catch (error) {
      if (this.disposed
        || !this.snapshotRequestGate.isProjectTracked(projectId)
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
  }

  private async runPhysicalRefresh(projectId: string): Promise<void> {
    if (this.disposed
      || !this.snapshotRequestGate.isProjectTracked(projectId)
      || !this.projects.getCachedContext(projectId)
      || this.coupledProviderIds.length === 0) {
      return;
    }
    const controller = new AbortController();
    this.physicalRefreshControllers.set(projectId, controller);
    try {
      await Promise.all(this.coupledProviderIds.map(providerId =>
        this.universe.refreshProviderProject(
          providerId,
          projectId,
          { projectId },
          controller.signal
        )
      ));
    } finally {
      if (this.physicalRefreshControllers.get(projectId) === controller) {
        this.physicalRefreshControllers.delete(projectId);
      }
    }
  }

  private handleRuntimeState(state: RsglRuntimeState): void {
    if (state.kind !== "ready") {
      this.unbindRuntime();
    }
    const reason = unavailableReasonFor(state, "transition");
    if (!reason) {
      return;
    }
    for (const projectId of this.snapshotRequestGate.getTrackedProjectIds()) {
      this.markProjectUnavailable(projectId, reason);
    }
  }

  private markProjectUnavailable(
    projectId: string,
    reason: ResourceProviderUnavailableReason
  ): void {
    if (this.disposed || this.snapshotRequestGate.hasActiveSnapshotRequest(projectId)) {
      return;
    }
    this.universe.invalidateProviderProject(this.provider.providerId, projectId, reason);
  }

  private forgetProject(projectId: string): void {
    if (this.disposed) {
      return;
    }
    this.snapshotRequestGate.forgetProject(projectId);
    this.provider.removeProject(projectId);
    this.backgroundRefreshScheduler.cancel(projectId);
    this.physicalRefreshScheduler.cancel(projectId);
    this.abortPhysicalRefresh(projectId);
    void this.controller.setProjectAvailable(this.projects.getCachedContexts().length > 0);
  }

  private isCurrentTrackedContext(context: ResourcePackProjectContextDto): boolean {
    const current = this.projects.getCachedContext(context.projectId);
    return !this.disposed
      && this.snapshotRequestGate.isProjectTracked(context.projectId)
      && current?.contextRevision === context.contextRevision;
  }

  private abortPhysicalRefresh(projectId: string): void {
    this.physicalRefreshControllers.get(projectId)?.abort();
  }

  private abortAllPhysicalRefreshes(): void {
    for (const controller of this.physicalRefreshControllers.values()) {
      controller.abort();
    }
  }

  private async shutdownNow(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controllerSubscription.dispose();
    this.universeSubscription.dispose();
    this.unbindRuntime();
    this.snapshotRequestGate.clearTrackedProjects();
    this.backgroundRefreshScheduler.dispose();
    this.physicalRefreshScheduler.dispose();
    this.abortAllPhysicalRefreshes();
    this.physicalOwnershipSubscription?.dispose();
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

function unavailableReasonFor(state: RsglRuntimeState, context: "query"): ResourceProviderUnavailableReason;
function unavailableReasonFor(
  state: RsglRuntimeState,
  context: "transition"
): ResourceProviderUnavailableReason | undefined;
function unavailableReasonFor(
  state: RsglRuntimeState,
  context: "query" | "transition"
): ResourceProviderUnavailableReason | undefined {
  if (state.kind === "suspended") {
    return state.reason === "disabled" ? "disabled" : "notProbed";
  }
  if (state.kind === "loading") {
    return "loading";
  }
  if (state.kind === "failed") {
    return "runtimeLoadFailed";
  }
  if (context === "query") {
    if (state.kind === "ready") {
      return "lspStarting";
    }
    return state.kind === "disposed" ? "disabled" : "notProbed";
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

function invalidationReasonFromNotification(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}
