import * as vscode from "vscode";
import { ResourceGraphTreeItem } from "./resourceGraphTreeItem";
import {
  ResourceGraphTreeModel,
  type ResourceGraphTreeDocument
} from "./resourceGraphTreeModel";

export { getResourceGraphNodeUri } from "./resourceGraphTreeItem";

export class ResourceGraphTreeProvider implements vscode.TreeDataProvider<ResourceGraphTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ResourceGraphTreeItem | undefined | null | void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(private readonly model: ResourceGraphTreeModel) { }

  public refresh(): void {
    this.clearRefreshTimer();
    this.model.invalidate();
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshActiveEditor(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshSoon(delay = 250): void {
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.model.invalidate();
      this.onDidChangeTreeDataEmitter.fire();
    }, delay);
  }

  public dispose(): void {
    this.clearRefreshTimer();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(element: ResourceGraphTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ResourceGraphTreeItem): Promise<ResourceGraphTreeItem[]> {
    const models = element
      ? await element.model.getChildren()
      : await this.model.getRoots(activeResourceGraphDocument());
    return models.map(model => new ResourceGraphTreeItem(model));
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

function activeResourceGraphDocument(): ResourceGraphTreeDocument | null {
  return vscode.window.activeTextEditor?.document ?? null;
}
