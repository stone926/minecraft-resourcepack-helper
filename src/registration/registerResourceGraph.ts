import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { ResourceGraphService } from "../services/resourceGraphService";
import { ResourceGraphTreeProvider } from "../views/resourceGraphTree";
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

export function registerResourceGraph(context: vscode.ExtensionContext): ResourceGraphController {
  const service = new ResourceGraphService();
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
    vscode.window.createTreeView("McResHelper.resourceGraph", {
      treeDataProvider: provider,
      showCollapseAll: true
    }),
    vscode.commands.registerCommand("McResHelper.refreshResourceGraph", () => controller.refresh())
  );
  return controller;
}
