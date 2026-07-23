import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type {
  ResourceContributionProvider,
  ResourceCoverageScope,
  ResourceProviderUnavailableReason
} from "../resourceUniverse/core/types";
import type {
  ResourceUniverseRefreshResult,
  ResourceUniverseService
} from "../resourceUniverse/core/resourceUniverseService";
import type { PhysicalAssetOwnedOutputLookup } from "../resourceUniverse/providers/physicalAssetProvider";
import {
  createRsglResourceSnapshotRequest,
  createRsglUnavailableSnapshotResponse,
  RsglGeneratedProvider
} from "../resourceUniverse/providers/rsglGeneratedProvider";
import { RsglGeneratedProviderConnection } from "../resourceUniverse/providers/rsglGeneratedProviderConnection";
import {
  hydrateRsglMaterializations,
  type RsglMaterializationHydrationHost
} from "./rsglMaterializationHydrator";
import {
  BackgroundRefreshScheduler,
  type BackgroundRefreshTimerHost
} from "./backgroundRefreshScheduler";
import { isAbortError } from "../utils/abortError";
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
  public readonly provider: RsglGeneratedProvider;
  public readonly connection: RsglGeneratedProviderConnection;

  private readonly relevantProjectIds = new Set<string>();
  private readonly activeSnapshotRequests = new Map<string, number>();
  private readonly appliedMaterializationTransactions = new Set<string>();
  private readonly backgroundRefreshScheduler: BackgroundRefreshScheduler<string>;
  private readonly physicalRefreshScheduler: BackgroundRefreshScheduler<string>;
  private readonly physicalRefreshControllers = new Map<string, AbortController>();
  private readonly hydrationPromises = new Map<string, Promise<void>>();
  private readonly materializationInvalidationPromises = new Set<Promise<boolean>>();
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
    const physicalOwnership = bindPhysicalOwnership(
      universe.registry.get("physical"),
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
    const application = this.applyCommittedMaterializationInvalidation(invalidation, context);
    this.materializationInvalidationPromises.add(application);
    try {
      return await application;
    } finally {
      this.materializationInvalidationPromises.delete(application);
    }
  }

  /** Used by tests and orderly shutdown to observe coalesced invalidation reloads. */
  public async whenIdle(): Promise<void> {
    while (
      this.hydrationPromises.size > 0
      || this.materializationInvalidationPromises.size > 0
    ) {
      await Promise.allSettled(
        [
          this.backgroundRefreshScheduler.whenIdle(),
          this.physicalRefreshScheduler.whenIdle(),
          ...this.hydrationPromises.values(),
          ...this.materializationInvalidationPromises
        ]
      );
    }
    await Promise.all([
      this.backgroundRefreshScheduler.whenIdle(),
      this.physicalRefreshScheduler.whenIdle()
    ]);
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

    this.activeSnapshotRequests.set(
      projectId,
      (this.activeSnapshotRequests.get(projectId) ?? 0) + 1
    );
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
      const remainingRequests = (this.activeSnapshotRequests.get(projectId) ?? 1) - 1;
      if (remainingRequests > 0) {
        this.activeSnapshotRequests.set(projectId, remainingRequests);
      } else {
        this.activeSnapshotRequests.delete(projectId);
      }
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

  private async applyCommittedMaterializationInvalidation(
    invalidation: MaterializationInvalidation,
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
      this.hydratedContextRevisions.set(context.projectId, context.contextRevision);
      this.invalidatePhysicalProject(context.projectId);
      this.backgroundRefreshScheduler.cancel(context.projectId);
      await this.connection.refreshProject(context.projectId);
      if (!this.isCurrentTrackedContext(context)) {
        return false;
      }
      if (this.coupledProviderIds.length > 0) {
        this.physicalRefreshScheduler.schedule(context.projectId, 0);
      }
      this.rememberMaterializationTransaction(invalidation.transactionId);
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
      || !this.relevantProjectIds.has(projectId)
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
      || !this.relevantProjectIds.has(projectId)
      || !this.projects.getCachedContext(projectId)) {
      return;
    }
    if (this.activeSnapshotRequests.has(projectId)) {
      this.backgroundRefreshScheduler.schedule(projectId);
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
  }

  private async runPhysicalRefresh(projectId: string): Promise<void> {
    if (this.disposed
      || !this.relevantProjectIds.has(projectId)
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
    this.backgroundRefreshScheduler.cancel(projectId);
    this.physicalRefreshScheduler.cancel(projectId);
    this.abortPhysicalRefresh(projectId);
    void this.controller.setProjectAvailable(this.projects.getCachedContexts().length > 0);
  }

  private isCurrentTrackedContext(context: ResourcePackProjectContextDto): boolean {
    const current = this.projects.getCachedContext(context.projectId);
    return !this.disposed
      && this.relevantProjectIds.has(context.projectId)
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
    this.unbindRuntime();
    this.relevantProjectIds.clear();
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

interface PhysicalOwnershipProviderCapability extends ResourceContributionProvider {
  readonly providerId: "physical";
  setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void };
}

interface BoundPhysicalOwnership {
  providerId: "physical";
  subscription: { dispose(): void };
}

/**
 * Provider instances may originate in another bundle, so constructor identity
 * is not a stable integration contract. Keep this optional seam structural and
 * isolate capability failures from the rest of bridge initialization.
 */
function bindPhysicalOwnership(
  provider: ResourceContributionProvider | undefined,
  lookup: PhysicalAssetOwnedOutputLookup
): BoundPhysicalOwnership | undefined {
  if (!hasPhysicalOwnershipCapability(provider)) {
    return undefined;
  }
  try {
    const subscription = provider.setOwnedOutputLookup(lookup);
    return isDisposable(subscription)
      ? { providerId: provider.providerId, subscription }
      : undefined;
  } catch {
    return undefined;
  }
}

function hasPhysicalOwnershipCapability(
  provider: ResourceContributionProvider | undefined
): provider is PhysicalOwnershipProviderCapability {
  try {
    return provider?.providerId === "physical"
      && "setOwnedOutputLookup" in provider
      && typeof provider.setOwnedOutputLookup === "function";
  } catch {
    return false;
  }
}

function isDisposable(value: unknown): value is { dispose(): void } {
  try {
    return typeof value === "object"
      && value !== null
      && "dispose" in value
      && typeof value.dispose === "function";
  } catch {
    return false;
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

function invalidationReasonFromNotification(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
