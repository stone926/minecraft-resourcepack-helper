import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { ResourceGraphService } from "../services/resourceGraphService";
import {
  resourcePathChangeAffectsSearchInventory,
  resourceUniverseChangeAffectsSearchInventory
} from "../services/resourceSearchInvalidation";
import { ResourceSearchService } from "../services/resourceSearchService";
import type { ResourceUniverseNavigation } from "../services/resourceUniverseNavigation";
import { ResourceGraphSearchQuickPick } from "../views/resourceGraphSearchQuickPick";
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
  showResourceSearch(): void;
  followActiveEditor(): void;
  invalidateProjectDiscovery(): void;
  invalidateProjectResolution(): void;
  invalidateDocument(document: ResourceGraphTreeDocument): void;
  invalidatePath(uri: ResourceGraphUriLike, kind?: ResourceGraphPathChangeKind): void;
  navigateNode(value: unknown, options?: { preferMaterialized?: boolean }): Promise<void>;
  showConflictOwners(value: unknown): Promise<void>;
  configureVanillaSource(): PromiseLike<unknown>;
}

export interface ResourceGraphRegistration {
  readonly controller: ResourceGraphController;
  readonly provider: ResourceGraphTreeProvider;
}

export function registerResourceGraph(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  navigation: ResourceUniverseNavigation
): ResourceGraphRegistration {
  const service = new ResourceGraphService(navigation);
  const search = new ResourceSearchService(navigation);
  const model = new ResourceGraphTreeModel(service, (message, ...args) => localize({ message, args }));
  const provider = new ResourceGraphTreeProvider(
    model,
    (producerId, target) => service.getKnownResource(producerId, target)
  );
  const searchPicker = new ResourceGraphSearchQuickPick(search, resource => {
    provider.focusResource(resource);
  });
  setFocusedResourceContext(false);
  context.subscriptions.push(
    provider,
    search,
    searchPicker,
    provider.onDidChangeFocus(setFocusedResourceContext),
    { dispose: () => setFocusedResourceContext(false) }
  );
  const controller: ResourceGraphController = {
    refresh: () => {
      service.invalidateAll();
      search.invalidate();
      provider.refresh();
    },
    refreshSoon: (delay, invalidateInventory) => provider.refreshSoon(delay, invalidateInventory),
    refreshActiveEditor: () => provider.refreshActiveEditor(),
    showResourceSearch: () => searchPicker.show(),
    followActiveEditor: () => { provider.followActiveEditor(); },
    invalidateProjectDiscovery: () => search.invalidateProjectDiscovery(),
    invalidateProjectResolution: () => search.invalidateProjectResolution(),
    invalidateDocument: document => {
      service.invalidateDocument(document);
    },
    invalidatePath: (uri, kind) => {
      service.invalidatePath(uri, kind);
      if (kind) {
        search.invalidateProjectMetadata(uri.fsPath, kind);
        if (resourcePathChangeAffectsSearchInventory(uri.fsPath, kind)) {
          search.invalidate();
        }
      }
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
    configureVanillaSource: () => service.configureVanillaSource()
  };
  const resourceChangeSubscription = navigation.onDidChangeResources(event => {
    if (resourceUniverseChangeAffectsSearchInventory(event)) {
      search.resourcesChanged(event);
    }
    provider.refreshSoon(50, true);
  });
  context.subscriptions.push(resourceChangeSubscription);
  return { controller, provider };
}

const focusedResourceContext = "McResHelper.resourceGraph.focusedResource";

function setFocusedResourceContext(value: boolean): void {
  void vscode.commands.executeCommand("setContext", focusedResourceContext, value);
}
