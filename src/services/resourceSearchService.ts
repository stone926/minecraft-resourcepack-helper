import * as path from "node:path";
import * as vscode from "vscode";
import { uniqueValues } from "../../packages/mc-assets/src";
import type {
  ResourceUniverseNavigation,
  UnifiedResourceInventory
} from "./resourceUniverseNavigationFacade";
import {
  isResourceSearchKind,
  resourceSearchKinds,
  searchResourceInventory,
  type ResourceSearchInventoryEntry,
  type ResourceSearchKind,
  type ResourceSearchMatch
} from "./resourceSearchModel";

export interface ResourceSearchRequest {
  query: string;
  kinds: readonly ResourceSearchKind[];
  limit?: number;
}

export interface ResourceSearchResponse {
  matches: readonly ResourceSearchMatch[];
  coverage: UnifiedResourceInventory["coverage"];
}

export class ResourceSearchService implements vscode.Disposable {
  private readonly listeners = new Set<() => void>();
  private inventory: Promise<UnifiedResourceInventory> | null = null;
  private inventoryAbortController: AbortController | null = null;
  private invalidatedWhileLoading = false;
  private projectAnchors: readonly vscode.Uri[] | null = null;
  private readonly workspaceFolderSubscription: vscode.Disposable;
  private disposed = false;

  public constructor(private readonly navigation: ResourceUniverseNavigation) {
    this.workspaceFolderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.projectAnchors = null;
      this.invalidate();
    });
  }

  public onDidInvalidate(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async search(request: ResourceSearchRequest): Promise<ResourceSearchResponse> {
    if (this.disposed) {
      throw new Error("Resource search service has been disposed.");
    }
    const inventory = await this.getInventory();
    return {
      matches: searchResourceInventory(
        inventory.resources.map(resource => ({
          target: resource.target,
          producer: resource.producer,
          resolutionStatus: resource.resolutionStatus,
          navigation: {
            kind: "producer",
            producerId: resource.producer.producerId,
            target: resource.target
          }
        } satisfies ResourceSearchInventoryEntry)),
        {
          query: request.query,
          kinds: request.kinds.filter(isResourceSearchKind),
          limit: request.limit ?? 200
        }
      ),
      coverage: inventory.coverage
    };
  }

  public invalidate(): void {
    if (this.disposed) {
      return;
    }
    if (this.inventoryAbortController) {
      this.invalidatedWhileLoading = true;
      return;
    }
    if (!this.inventory) {
      return;
    }
    this.inventory = null;
    this.fireInvalidated();
  }

  public invalidateProjectDiscovery(): void {
    if (this.disposed) {
      return;
    }
    this.projectAnchors = null;
    this.invalidate();
  }

  /**
   * Provider replacement events raised by this service's own ensure pass are
   * already reflected in the inventory being assembled.
   */
  public resourcesChanged(): void {
    if (this.disposed) {
      return;
    }
    if (this.inventoryAbortController) {
      return;
    }
    this.invalidate();
  }

  public invalidateProjectDiscoveryForPath(fileName: string): void {
    if (this.disposed) {
      return;
    }
    const basename = path.basename(fileName).toLowerCase();
    if (basename !== "pack.mcmeta" && basename !== "rsgl.config.json") {
      return;
    }
    this.invalidateProjectDiscovery();
  }

  public dispose(): void {
    this.disposed = true;
    this.workspaceFolderSubscription.dispose();
    this.inventoryAbortController?.abort();
    this.inventoryAbortController = null;
    this.inventory = null;
    this.listeners.clear();
  }

  private getInventory(): Promise<UnifiedResourceInventory> {
    if (!this.inventory) {
      const controller = new AbortController();
      this.inventoryAbortController = controller;
      const loading = this.loadInventory(controller.signal).catch(error => {
        if (this.inventory === loading) {
          this.inventory = null;
          this.invalidatedWhileLoading = false;
        }
        throw error;
      }).finally(() => {
        if (this.inventoryAbortController === controller) {
          this.inventoryAbortController = null;
        }
        if (this.invalidatedWhileLoading && this.inventory === loading) {
          this.invalidatedWhileLoading = false;
          this.inventory = null;
          this.fireInvalidated();
        }
      });
      this.inventory = loading;
    }
    return this.inventory;
  }

  private fireInvalidated(): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private async loadInventory(signal: AbortSignal): Promise<UnifiedResourceInventory> {
    const anchors = await this.getProjectAnchors(signal);
    const ensured = await Promise.all(anchors.map(uri =>
      this.navigation.ensureProjectForUri(uri, {
        includeGenerated: true,
        signal
      })
    ));
    const projectIds = uniqueValues(ensured.flatMap(result =>
      result.context ? [result.context.projectId] : []
    ));
    return this.navigation.getKnownResources(resourceSearchKinds, {
      signal,
      projectIds
    });
  }

  private async getProjectAnchors(signal: AbortSignal): Promise<readonly vscode.Uri[]> {
    if (this.projectAnchors) {
      return this.projectAnchors;
    }
    const anchors = await discoverProjectAnchors(signal);
    if (!signal.aborted) {
      this.projectAnchors = anchors;
    }
    return anchors;
  }
}

async function discoverProjectAnchors(signal: AbortSignal): Promise<vscode.Uri[]> {
  const discovered = await vscode.workspace.findFiles(
    "{**/pack.mcmeta,**/rsgl.config.json}",
    "{**/.git/**,**/node_modules/**,**/out/**}",
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
