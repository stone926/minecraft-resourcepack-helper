import * as vscode from "vscode";
import type {
  ResourceGraphCollapsibleState,
  ResourceGraphTreeNodeModel,
  ResourceGraphUriLike
} from "./resourceGraphTreeModel";
import { createResourceGraphTreeItemPresentation } from "./resourceGraphTreeItemPresentation";

export class ResourceGraphTreeItem extends vscode.TreeItem {
  public readonly resourceUri?: vscode.Uri;

  public constructor(public readonly model: ResourceGraphTreeNodeModel) {
    const presentation = createResourceGraphTreeItemPresentation(model);
    super(presentation.label, toCollapsibleState(presentation.collapsibleState));
    this.description = presentation.description;
    this.iconPath = new vscode.ThemeIcon(presentation.icon);
    this.contextValue = presentation.contextValue;
    this.tooltip = presentation.tooltip;
    this.resourceUri = model.resourceUri ? toVscodeUri(model.resourceUri) : undefined;
    if (this.resourceUri) {
      this.command = {
        command: "vscode.open",
        title: vscode.l10n.t("Open Resource"),
        arguments: [this.resourceUri]
      };
    }
  }
}

export function getResourceGraphNodeUri(value: unknown): vscode.Uri | null {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const resourceUri = (value as { resourceUri?: unknown }).resourceUri;
  return resourceUri instanceof vscode.Uri ? resourceUri : null;
}

function toCollapsibleState(state: ResourceGraphCollapsibleState): vscode.TreeItemCollapsibleState {
  switch (state) {
    case "expanded": return vscode.TreeItemCollapsibleState.Expanded;
    case "collapsed": return vscode.TreeItemCollapsibleState.Collapsed;
    default: return vscode.TreeItemCollapsibleState.None;
  }
}

function toVscodeUri(uri: ResourceGraphUriLike): vscode.Uri {
  return uri instanceof vscode.Uri ? uri : vscode.Uri.file(uri.fsPath);
}
