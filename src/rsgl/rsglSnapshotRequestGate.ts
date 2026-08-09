import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type {
  ResourceContributionRequest,
  ResourceProviderUnavailableReason
} from "../resourceUniverse/core/types";
import {
  createRsglResourceSnapshotRequest,
  createRsglUnavailableSnapshotResponse
} from "./provider/rsglGeneratedProvider";
import { LruCache } from "../services/lruCache";
import { abortSignalError } from "../../packages/shared-utils/src";
import type { RsglRuntimeInstance } from "./runtime";

const rememberedMaterializationTransactionLimit = 256;

interface PendingHydration {
  readonly contextRevision: string;
  readonly token: symbol;
  readonly promise: Promise<void>;
}

export interface RsglSnapshotRequestGateHost {
  getProjectContext(projectId: string): ResourcePackProjectContextDto | undefined;
  isRuntimeDisabled(): boolean;
  ensureLanguageServer(projectId: string): Promise<RsglRuntimeInstance | null>;
  getRuntimeUnavailableReason(): ResourceProviderUnavailableReason;
  getLanguageServerFailureReason(error: unknown): ResourceProviderUnavailableReason;
  getLastKnownRevision(projectId: string): string | undefined;
}

/**
 * Owns the state that gates generated snapshot requests and materialization
 * hydration. The bridge supplies runtime/project operations while this class
 * keeps request counts, single-flight promises, and the bounded transaction
 * history coherent.
 */
export class RsglSnapshotRequestGate {
  private readonly trackedProjectIds = new Set<string>();
  private readonly activeSnapshotRequests = new Map<string, number>();
  private readonly hydrationPromises = new Map<string, PendingHydration>();
  private readonly hydrationApplications = new Set<Promise<void>>();
  private readonly materializationApplications = new Set<Promise<unknown>>();
  private readonly applyingMaterializationTransactions = new Set<string>();
  private readonly hydratedContextRevisions = new Map<string, string>();
  private readonly materializationTransactions = new LruCache<string, true>(
    rememberedMaterializationTransactionLimit
  );

  public constructor(private readonly host: RsglSnapshotRequestGateHost) {}

  public trackProject(projectId: string): void {
    this.trackedProjectIds.add(projectId);
  }

  public isProjectTracked(projectId: string): boolean {
    return this.trackedProjectIds.has(projectId);
  }

  public getTrackedProjectIds(): readonly string[] {
    return [...this.trackedProjectIds];
  }

  public hasActiveSnapshotRequest(projectId: string): boolean {
    return this.activeSnapshotRequests.has(projectId);
  }

  public async requestSnapshot(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const projectId = request.projectId;
    const context = this.host.getProjectContext(projectId);
    if (!context || !this.isProjectTracked(projectId)) {
      return createRsglUnavailableSnapshotResponse(request, "notProbed");
    }
    if (this.host.isRuntimeDisabled()) {
      return this.unavailableResponse(request, "disabled");
    }

    this.beginSnapshotRequest(projectId);
    try {
      let runtime: RsglRuntimeInstance | null;
      try {
        runtime = await this.host.ensureLanguageServer(projectId);
      } catch (error) {
        return this.unavailableResponse(
          request,
          this.host.getLanguageServerFailureReason(error)
        );
      }
      if (signal.aborted) {
        throw snapshotRequestAbortError(signal);
      }
      if (!runtime) {
        return this.unavailableResponse(request, this.host.getRuntimeUnavailableReason());
      }
      if (!runtime.requestResourceSnapshot) {
        return this.unavailableResponse(request, "protocolMismatch");
      }
      return await runtime.requestResourceSnapshot(
        createRsglResourceSnapshotRequest(request, context),
        signal
      );
    } catch {
      if (signal.aborted) {
        throw snapshotRequestAbortError(signal);
      }
      return this.unavailableResponse(request, "lspFailed");
    } finally {
      this.endSnapshotRequest(projectId);
    }
  }

  public ensureHydrated<T>(
    projectId: string,
    contextRevision: string,
    hydrate: () => Promise<T>,
    commit: (hydrated: T) => boolean | void
  ): Promise<void> {
    if (this.hydratedContextRevisions.get(projectId) === contextRevision) {
      return Promise.resolve();
    }
    const existing = this.hydrationPromises.get(projectId);
    if (existing?.contextRevision === contextRevision) {
      return existing.promise;
    }

    const token = Symbol("rsgl-hydration");
    const hydration = Promise.resolve()
      .then(hydrate)
      .then(hydrated => {
        if (this.hydrationPromises.get(projectId)?.token !== token) {
          return;
        }
        const committed = commit(hydrated);
        if (
          committed !== false
          && this.hydrationPromises.get(projectId)?.token === token
        ) {
          this.hydratedContextRevisions.set(projectId, contextRevision);
        }
      })
      .finally(() => {
        this.hydrationApplications.delete(hydration);
        if (this.hydrationPromises.get(projectId)?.token === token) {
          this.hydrationPromises.delete(projectId);
        }
      });
    this.hydrationPromises.set(projectId, { contextRevision, token, promise: hydration });
    this.hydrationApplications.add(hydration);
    return hydration;
  }

  public markHydrated(projectId: string, contextRevision: string): void {
    this.hydrationPromises.delete(projectId);
    this.hydratedContextRevisions.set(projectId, contextRevision);
  }

  public hasMaterializationTransaction(transactionId: string): boolean {
    return this.applyingMaterializationTransactions.has(transactionId)
      || this.materializationTransactions.get(transactionId) === true;
  }

  public rememberMaterializationTransaction(transactionId: string): void {
    this.materializationTransactions.set(transactionId, true);
  }

  public trackMaterializationApplication<T>(
    transactionId: string,
    application: Promise<T>
  ): Promise<T> {
    this.applyingMaterializationTransactions.add(transactionId);
    const tracked = application.finally(() => {
      this.materializationApplications.delete(tracked);
      this.applyingMaterializationTransactions.delete(transactionId);
    });
    this.materializationApplications.add(tracked);
    return tracked;
  }

  public async whenIdle(): Promise<void> {
    while (this.hydrationApplications.size > 0 || this.materializationApplications.size > 0) {
      await Promise.allSettled([
        ...this.hydrationApplications,
        ...this.materializationApplications
      ]);
    }
  }

  public forgetProject(projectId: string): void {
    this.trackedProjectIds.delete(projectId);
    this.hydratedContextRevisions.delete(projectId);
    this.hydrationPromises.delete(projectId);
  }

  public clearTrackedProjects(): void {
    this.trackedProjectIds.clear();
    this.hydratedContextRevisions.clear();
    this.hydrationPromises.clear();
  }

  private beginSnapshotRequest(projectId: string): void {
    this.activeSnapshotRequests.set(
      projectId,
      (this.activeSnapshotRequests.get(projectId) ?? 0) + 1
    );
  }

  private endSnapshotRequest(projectId: string): void {
    const remainingRequests = (this.activeSnapshotRequests.get(projectId) ?? 1) - 1;
    if (remainingRequests > 0) {
      this.activeSnapshotRequests.set(projectId, remainingRequests);
    } else {
      this.activeSnapshotRequests.delete(projectId);
    }
  }

  private unavailableResponse(
    request: ResourceContributionRequest,
    reason: ResourceProviderUnavailableReason
  ): ReturnType<typeof createRsglUnavailableSnapshotResponse> {
    return createRsglUnavailableSnapshotResponse(
      request,
      reason,
      this.host.getLastKnownRevision(request.projectId)
    );
  }
}

function snapshotRequestAbortError(signal: AbortSignal): Error {
  return abortSignalError(signal, "The RSGL resource snapshot request was cancelled.");
}
