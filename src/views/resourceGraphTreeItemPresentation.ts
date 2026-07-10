import type {
  ResourceGraphCollapsibleState,
  ResourceGraphTreeNodeModel
} from "./resourceGraphTreeModel";
import type { ResourceGraphPreviewContext } from "./resourceGraphPreviewClassifier";

export interface ResourceGraphTreeItemPresentation {
  label: string;
  collapsibleState: ResourceGraphCollapsibleState;
  description?: string;
  icon: string;
  contextValue?: ResourceGraphPreviewContext;
  tooltip?: string;
}

export function createResourceGraphTreeItemPresentation(
  model: ResourceGraphTreeNodeModel
): ResourceGraphTreeItemPresentation {
  return {
    label: model.label,
    collapsibleState: model.collapsibleState,
    description: model.description,
    icon: model.icon,
    contextValue: model.contextValue,
    tooltip: model.tooltip
  };
}
