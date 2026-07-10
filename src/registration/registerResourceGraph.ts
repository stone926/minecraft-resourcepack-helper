import * as vscode from "vscode";
import { localize } from "../i18n/runtime";
import { ResourceGraphService } from "../services/resourceGraphService";
import { ResourceGraphTreeProvider } from "../views/resourceGraphTree";
import {
  ResourceGraphTreeModel,
  type ResourceGraphTreeDocument,
  type ResourceGraphUriLike
} from "../views/resourceGraphTreeModel";

export interface ResourceGraphController {
  refresh(): void;
  refreshSoon(delay?: number): void;
  refreshActiveEditor(): void;
  invalidateDocument(document: ResourceGraphTreeDocument): void;
  invalidatePath(uri: ResourceGraphUriLike): void;
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
    refreshSoon: delay => provider.refreshSoon(delay),
    refreshActiveEditor: () => provider.refreshActiveEditor(),
    invalidateDocument: document => service.invalidateDocument(document),
    invalidatePath: uri => service.invalidatePath(uri)
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
