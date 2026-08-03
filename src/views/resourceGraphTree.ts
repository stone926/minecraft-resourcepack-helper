import * as vscode from "vscode";
import { createTrailingDebouncer } from "../utils/debounce";
import { ResourceGraphTreeItem } from "./resourceGraphTreeItem";
import {
  ResourceGraphTreeModel,
  type ResourceGraphProjectedResource,
  type ResourceGraphTreeDocument
} from "./resourceGraphTreeModel";

interface FocusedResourceIdentity {
  readonly producerId: string;
  readonly target: ResourceGraphProjectedResource["target"];
}

export class ResourceGraphTreeProvider implements vscode.TreeDataProvider<ResourceGraphTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ResourceGraphTreeItem | undefined | null | void>();
  private readonly onDidChangeFocusEmitter = new vscode.EventEmitter<boolean>();
  private readonly refreshDebouncer = createTrailingDebouncer();
  private focusedResource: FocusedResourceIdentity | undefined;
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  public readonly onDidChangeFocus = this.onDidChangeFocusEmitter.event;

  public constructor(
    private readonly model: ResourceGraphTreeModel,
    private readonly resolveFocusedResource: (
      producerId: string,
      target: ResourceGraphProjectedResource["target"]
    ) => ResourceGraphProjectedResource | undefined
  ) { }

  public refresh(): void {
    this.refreshDebouncer.cancel();
    this.model.invalidate();
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshActiveEditor(): void {
    if (!this.focusedResource) {
      this.onDidChangeTreeDataEmitter.fire();
    }
  }

  public focusResource(resource: ResourceGraphProjectedResource): void {
    this.focusedResource = {
      producerId: resource.producer.producerId,
      target: resource.target
    };
    this.onDidChangeFocusEmitter.fire(true);
    this.onDidChangeTreeDataEmitter.fire();
  }

  public followActiveEditor(): boolean {
    if (!this.focusedResource) {
      return false;
    }
    this.focusedResource = undefined;
    this.onDidChangeFocusEmitter.fire(false);
    this.onDidChangeTreeDataEmitter.fire();
    return true;
  }

  public refreshSoon(delay = 250, invalidateInventory = false): void {
    this.refreshDebouncer.schedule(() => {
      if (invalidateInventory) {
        this.model.invalidate();
      }
      this.onDidChangeTreeDataEmitter.fire();
    }, delay);
  }

  public dispose(): void {
    this.refreshDebouncer.cancel();
    this.focusedResource = undefined;
    this.onDidChangeFocusEmitter.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(element: ResourceGraphTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ResourceGraphTreeItem): Promise<ResourceGraphTreeItem[]> {
    const focusedResource = element ? undefined : this.resolveCurrentFocus();
    const models = element
      ? await element.model.getChildren()
      : await this.model.getRoots(
          activeResourceGraphDocument(),
          focusedResource
        );
    return models.map(model => new ResourceGraphTreeItem(model));
  }

  private resolveCurrentFocus(): ResourceGraphProjectedResource | undefined {
    const focused = this.focusedResource;
    if (!focused) {
      return undefined;
    }
    const current = this.resolveFocusedResource(focused.producerId, focused.target);
    if (current) {
      return current;
    }
    this.focusedResource = undefined;
    this.onDidChangeFocusEmitter.fire(false);
    return undefined;
  }

}

function activeResourceGraphDocument(): ResourceGraphTreeDocument | null {
  return vscode.window.activeTextEditor?.document ?? null;
}
