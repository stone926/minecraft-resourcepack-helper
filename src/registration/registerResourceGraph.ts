import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { ResourceGraphService } from "../services/resourceGraphService";
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
  invalidateDocument(document: ResourceGraphTreeDocument): void;
  invalidatePath(uri: ResourceGraphUriLike, kind?: ResourceGraphPathChangeKind): void;
}

export function registerResourceGraph(
  context: vscode.ExtensionContext,
  navigation: ResourceUniverseNavigation
): ResourceGraphController {
  const service = new ResourceGraphService(navigation);
  const model = new ResourceGraphTreeModel(service, (message, ...args) => localize({ message, args }));
  const provider = new ResourceGraphTreeProvider(model);
  const controller: ResourceGraphController = {
    refresh: () => {
      service.invalidateAll();
      provider.refresh();
    },
    refreshSoon: (delay, invalidateInventory) => provider.refreshSoon(delay, invalidateInventory),
    refreshActiveEditor: () => provider.refreshActiveEditor(),
    invalidateDocument: document => service.invalidateDocument(document),
    invalidatePath: (uri, kind) => service.invalidatePath(uri, kind)
  };
  context.subscriptions.push(
    provider,
    navigation.onDidChangeResources(() => provider.refreshSoon(50, true)),
    vscode.window.createTreeView("McResHelper.resourceGraph", {
      treeDataProvider: provider,
      showCollapseAll: true
    }),
    vscode.commands.registerCommand("McResHelper.refreshResourceGraph", () => controller.refresh()),
    vscode.commands.registerCommand("McResHelper.navigateResourceGraphNode", async value => {
      const target = getResourceGraphNodeNavigation(value);
      if (target) {
        await service.navigate(target);
      }
    }),
    vscode.commands.registerCommand("McResHelper.openGeneratedResource", async value => {
      const target = getResourceGraphNodeNavigation(value);
      if (target) {
        await service.navigate(target, { preferMaterialized: false });
      }
    }),
    vscode.commands.registerCommand("McResHelper.openMaterializedResource", async value => {
      const target = getResourceGraphNodeNavigation(value);
      if (target) {
        await service.navigate(target, { preferMaterialized: true });
      }
    }),
    vscode.commands.registerCommand("McResHelper.showResourceConflictOwners", async value => {
      const resource = getResourceGraphNodeModel(value)?.resource;
      if (resource) {
        await service.showConflictOwners(resource);
      }
    }),
    vscode.commands.registerCommand("McResHelper.configureVanillaSource", () =>
      service.configureVanillaSource()
    )
  );
  return controller;
}
