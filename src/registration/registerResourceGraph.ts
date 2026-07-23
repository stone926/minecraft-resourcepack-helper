import type { ExtensionContext } from "vscode";
import { localize } from "../i18n/runtime";
import { ResourceGraphService } from "../services/resourceGraphService";
import {
  ResourceSearchService,
  type ResourceSearchRequest,
  type ResourceSearchResponse
} from "../services/resourceSearchService";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigationFacade";
import { ResourceGraphTreeProvider } from "../views/resourceGraphTree";
import {
  getResourceGraphNodeModel,
  getResourceGraphNodeNavigation
} from "../views/resourceGraphTreeItem";
import {
  ResourceGraphTreeModel,
  type ResourceGraphTreeDocument,
  type ResourceGraphUriLike
} from "../views/resourceGraphTreeModel";
import type { ResourceGraphPathChangeKind } from "../utils/resourceGraph";

export interface ResourceGraphController {
  refresh(): void;
  refreshSoon(delay?: number, invalidateInventory?: boolean): void;
  refreshActiveEditor(): void;
  invalidateProjectDiscovery(): void;
  invalidateDocument(document: ResourceGraphTreeDocument): void;
  invalidatePath(uri: ResourceGraphUriLike, kind?: ResourceGraphPathChangeKind): void;
  navigateNode(value: unknown, options?: { preferMaterialized?: boolean }): Promise<void>;
  showConflictOwners(value: unknown): Promise<void>;
  configureVanillaSource(): PromiseLike<unknown>;
  searchResources(request: ResourceSearchRequest): Promise<ResourceSearchResponse>;
  onDidInvalidateSearch(listener: () => void): { dispose(): void };
}

export interface ResourceGraphRegistration {
  readonly controller: ResourceGraphController;
  readonly provider: ResourceGraphTreeProvider;
}

export function registerResourceGraph(
  context: Pick<ExtensionContext, "subscriptions">,
  navigation: ResourceUniverseNavigation
): ResourceGraphRegistration {
  const service = new ResourceGraphService(navigation);
  const search = new ResourceSearchService(navigation);
  const model = new ResourceGraphTreeModel(service, (message, ...args) => localize({ message, args }));
  const provider = new ResourceGraphTreeProvider(model);
  context.subscriptions.push(provider, search);
  const controller: ResourceGraphController = {
    refresh: () => {
      service.invalidateAll();
      search.invalidateProjectDiscovery();
      provider.refresh();
    },
    refreshSoon: (delay, invalidateInventory) => provider.refreshSoon(delay, invalidateInventory),
    refreshActiveEditor: () => provider.refreshActiveEditor(),
    invalidateProjectDiscovery: () => search.invalidateProjectDiscovery(),
    invalidateDocument: document => {
      service.invalidateDocument(document);
      search.invalidate();
    },
    invalidatePath: (uri, kind) => {
      service.invalidatePath(uri, kind);
      search.invalidateProjectDiscoveryForPath(uri.fsPath);
      search.invalidate();
    },
    navigateNode: async (value, options) => {
      const target = getResourceGraphNodeNavigation(value);
      if (target) {
        await service.navigate(target, options);
      }
    },
    showConflictOwners: async value => {
      const resource = getResourceGraphNodeModel(value)?.resource;
      if (resource) {
        await service.showConflictOwners(resource);
      }
    },
    configureVanillaSource: () => service.configureVanillaSource(),
    searchResources: request => search.search(request),
    onDidInvalidateSearch: listener => search.onDidInvalidate(listener)
  };
  const resourceChangeSubscription = navigation.onDidChangeResources(() => {
    search.resourcesChanged();
    provider.refreshSoon(50, true);
  });
  context.subscriptions.push(resourceChangeSubscription);
  return { controller, provider };
}
