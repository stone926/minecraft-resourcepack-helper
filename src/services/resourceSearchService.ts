import {
  isResourceProjectAnchorFileName,
  resourceProjectAnchorSearchGlob
} from "../../packages/resource-project/src";
import { getIgnoredWorkspaceGlob } from "../resources/resourceSurfaceRegistry";
import * as path from "node:path";
import * as vscode from "vscode";
import { uniqueValues } from "../../packages/mc-assets/src";
import type { ResourceUniverseChangeEvent } from "../resourceUniverse";
import type { ResourceGraphPathChangeKind } from "../utils/resourceGraph";
import { throwIfAborted } from "../utils/abortError";
import type {
  ResourceUniverseNavigation,
  UnifiedResourceInventory
} from "./resourceUniverseNavigationFacade";
import { LruCache } from "./lruCache";
import {
  isResourceSearchKind,
  prepareResourceSearchInventory,
  resourceSearchKinds,
  resourceSearchQueryKey,
  searchPreparedResourceInventory,
  type PreparedResourceSearchInventory,
  type ResourceSearchInventoryEntry,
  type ResourceSearchKind,
  type ResourceSearchMatch
} from "./resourceSearchModel";

export interface ResourceSearchRequest {
  query: string;
  kinds: readonly ResourceSearchKind[];
  limit?: number;
  /** Cancels this query's filtering/sorting without cancelling shared inventory work. */
  signal?: AbortSignal;
}

export interface ResourceSearchResponse {
  matches: readonly ResourceSearchMatch[];
  coverage: UnifiedResourceInventory["coverage"];
}

interface PreparedResourceSearchSnapshot {
  readonly inventory: PreparedResourceSearchInventory;
  readonly coverage: UnifiedResourceInventory["coverage"];
  readonly revision: number;
}

const resourceSearchResponseCacheSize = 64;
const maximumInventoryStabilizationRetries = 2;

export class ResourceSearchService implements vscode.Disposable {
  private readonly responseCache =
    new LruCache<string, ResourceSearchResponse>(resourceSearchResponseCacheSize);
  private readonly invalidationListeners = new Set<() => void>();
  private inventory: Promise<PreparedResourceSearchSnapshot> | null = null;
  private inventoryAbortController: AbortController | null = null;
  private inventoryCauseId: symbol | null = null;
  private inventoryInvalidatedWhileLoading = false;
  private inventoryRevision = 0;
  private projectAnchors: readonly vscode.Uri[] | null = null;
  private projectIds: readonly string[] | null = null;
  private projectDiscoveryRevision = 0;
  private projectResolutionRevision = 0;
  private readonly workspaceFolderSubscription: vscode.Disposable;
  private disposed = false;

  public constructor(private readonly navigation: ResourceUniverseNavigation) {
    this.workspaceFolderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.invalidateProjectDiscovery()
    );
  }

  public async search(request: ResourceSearchRequest): Promise<ResourceSearchResponse> {
    if (this.disposed) {
      throw new Error("Resource search service has been disposed.");
    }
    throwIfAborted(request.signal);
    const query = {
      query: request.query,
      kinds: request.kinds.filter(isResourceSearchKind),
      limit: request.limit ?? 200
    };
    const cacheKey = resourceSearchQueryKey(query);
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let stabilizationRetries = 0;
    while (!this.disposed) {
      const snapshot = await this.getInventory();
      throwIfAborted(request.signal);
      const current = snapshot.revision === this.inventoryRevision;
      if (!current && stabilizationRetries < maximumInventoryStabilizationRetries) {
        stabilizationRetries++;
        continue;
      }
      const cachedAfterLoad = this.responseCache.get(cacheKey);
      if (cachedAfterLoad) {
        return cachedAfterLoad;
      }
      throwIfAborted(request.signal);
      const response = {
        matches: searchPreparedResourceInventory(snapshot.inventory, query),
        coverage: snapshot.coverage
      } satisfies ResourceSearchResponse;
      if (current) {
        this.responseCache.set(cacheKey, response);
      }
      return response;
    }
    throw new Error("Resource search service has been disposed.");
  }

  /**
   * Signals that cached search results are no longer current. Consumers decide
   * whether they have an active query worth rerunning; invalidation itself
   * never starts inventory discovery or indexing work.
   */
  public onDidInvalidate(listener: () => void): vscode.Disposable {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    this.invalidationListeners.add(listener);
    return { dispose: () => this.invalidationListeners.delete(listener) };
  }

  public invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.inventoryRevision++;
    this.responseCache.clear();
    if (this.inventoryAbortController) {
      this.inventoryInvalidatedWhileLoading = true;
    } else {
      this.inventory = null;
    }
    for (const listener of this.invalidationListeners) {
      try {
        listener();
      } catch {
        // A view listener must not compromise cache invalidation semantics.
      }
    }
  }

  public invalidateProjectDiscovery(): void {
    if (this.disposed) {
      return;
    }
    this.projectAnchors = null;
    this.projectIds = null;
    this.projectDiscoveryRevision++;
    this.projectResolutionRevision++;
    this.invalidate();
  }

  public invalidateProjectResolution(): void {
    if (this.disposed) {
      return;
    }
    this.projectIds = null;
    this.projectResolutionRevision++;
    this.invalidate();
  }

  public resourcesChanged(event?: ResourceUniverseChangeEvent): void {
    if (this.disposed) {
      return;
    }
    if (event?.causeId
      && event.causeId === this.inventoryCauseId
      && event.kind !== "removal") {
      return;
    }
    if (event?.kind === "removal") {
      this.invalidateProjectResolution();
      return;
    }
    this.invalidate();
  }

  public invalidateProjectMetadata(
    fileName: string,
    kind: ResourceGraphPathChangeKind
  ): void {
    if (this.disposed) {
      return;
    }
    const basename = path.basename(fileName).toLowerCase();
    if (!isResourceProjectAnchorFileName(basename)) {
      return;
    }
    if (kind === "change") {
      // Anchor membership is unchanged, but the project service evicts the
      // resolved context for metadata edits. Re-resolve cached anchors without
      // paying for another workspace-wide findFiles pass.
      this.invalidateProjectResolution();
    } else {
      this.invalidateProjectDiscovery();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.workspaceFolderSubscription.dispose();
    this.inventoryAbortController?.abort();
    this.inventoryAbortController = null;
    this.inventoryCauseId = null;
    this.inventory = null;
    this.projectAnchors = null;
    this.projectIds = null;
    this.responseCache.clear();
    this.invalidationListeners.clear();
  }

  private getInventory(): Promise<PreparedResourceSearchSnapshot> {
    if (!this.inventory) {
      const controller = new AbortController();
      const causeId = Symbol("resource-search-inventory");
      const revision = this.inventoryRevision;
      this.inventoryAbortController = controller;
      this.inventoryCauseId = causeId;
      const loading = this.loadInventory(controller.signal, causeId).then(snapshot => ({
        ...snapshot,
        revision
      })).catch(error => {
        if (this.inventory === loading) {
          this.inventory = null;
        }
        throw error;
      }).finally(() => {
        if (this.inventoryAbortController === controller) {
          this.inventoryAbortController = null;
        }
        if (this.inventoryCauseId === causeId) {
          this.inventoryCauseId = null;
        }
        if (this.inventoryInvalidatedWhileLoading && this.inventory === loading) {
          this.inventory = null;
        }
        this.inventoryInvalidatedWhileLoading = false;
      });
      this.inventory = loading;
    }
    return this.inventory;
  }

  private async loadInventory(
    signal: AbortSignal,
    causeId: symbol
  ): Promise<Omit<PreparedResourceSearchSnapshot, "revision">> {
    const projectIds = await this.getProjectIds(signal, causeId);
    const inventory = await this.navigation.getKnownResources(resourceSearchKinds, {
      signal,
      projectIds,
      causeId
    });
    return {
      inventory: prepareResourceSearchInventory(inventory.resources.map(resource => ({
        target: resource.target,
        producer: resource.producer,
        candidates: resource.candidates,
        resolutionStatus: resource.resolutionStatus,
        navigation: {
          kind: "producer",
          producerId: resource.producer.producerId,
          target: resource.target
        }
      } satisfies ResourceSearchInventoryEntry))),
      coverage: inventory.coverage
    };
  }

  private async getProjectIds(
    signal: AbortSignal,
    causeId: symbol
  ): Promise<readonly string[]> {
    if (this.projectIds) {
      return this.projectIds;
    }
    const revision = this.projectResolutionRevision;
    const anchors = await this.getProjectAnchors(signal);
    const ensured = await Promise.all(anchors.map(uri =>
      this.navigation.ensureProjectForUri(uri, {
        includeGenerated: false,
        signal,
        causeId
      })
    ));
    const projectIds = uniqueValues(ensured.flatMap(result =>
      result.context ? [result.context.projectId] : []
    ));
    if (!signal.aborted && revision === this.projectResolutionRevision) {
      this.projectIds = projectIds;
    }
    return projectIds;
  }

  private async getProjectAnchors(signal: AbortSignal): Promise<readonly vscode.Uri[]> {
    if (this.projectAnchors) {
      return this.projectAnchors;
    }
    const revision = this.projectDiscoveryRevision;
    const anchors = await discoverProjectAnchors(signal);
    if (!signal.aborted && revision === this.projectDiscoveryRevision) {
      this.projectAnchors = anchors;
    }
    return anchors;
  }
}

async function discoverProjectAnchors(signal: AbortSignal): Promise<vscode.Uri[]> {
  const discovered = await vscode.workspace.findFiles(
    resourceProjectAnchorSearchGlob,
    getIgnoredWorkspaceGlob(),
    undefined,
    cancellationToken(signal)
  );
  const anchors = [
    ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? []),
    ...discovered
  ];
  return [...new Map(anchors.map(uri => [uri.toString(), uri])).values()];
}

function cancellationToken(signal: AbortSignal): vscode.CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested: listener => {
      signal.addEventListener("abort", listener, { once: true });
      return {
        dispose: () => signal.removeEventListener("abort", listener)
      };
    }
  };
}
