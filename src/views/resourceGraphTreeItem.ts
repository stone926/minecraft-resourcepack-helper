import { internalCommands } from "../commandIds";
import * as vscode from "vscode";
import type {
  ResourceGraphCollapsibleState,
  ResourceGraphNodeNavigation,
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
    if (model.navigation) {
      this.command = {
        command: internalCommands.navigateResourceGraphNode,
        title: vscode.l10n.t("Open Resource"),
        arguments: [model.navigation]
      };
    }
  }
}

export function getResourceGraphNodeModel(value: unknown): ResourceGraphTreeNodeModel | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return model && typeof model === "object"
    ? model as ResourceGraphTreeNodeModel
    : null;
}

export function getResourceGraphNodeNavigation(value: unknown): ResourceGraphNodeNavigation | null {
  const model = getResourceGraphNodeModel(value);
  return model?.navigation ?? (isResourceGraphNodeNavigation(value) ? value : null);
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
  return uri instanceof vscode.Uri ? uri : vscode.Uri.parse(uri.toString(), true);
}

function isResourceGraphNodeNavigation(value: unknown): value is ResourceGraphNodeNavigation {
  return !!value && typeof value === "object"
    && ["producer", "resourceUri", "location"].includes(
      String((value as { kind?: unknown }).kind)
    );
}
