import { resourceUriKey } from "../utils/resourceGraphSearch";
import { classifyResourceGraphPreview } from "./resourceGraphPreviewClassifier";
import {
  generatedResourceContext,
  generatedResourceLabel,
  generatedResourceTooltip
} from "./resourceGraphGeneratedPresentation";
import {
  getGeneratedResourceIcon,
  getResourceIcon,
  getResourcePathLabel
} from "./resourceGraphNodePresentation";
import type {
  ResourceGraphCollapsibleState,
  ResourceGraphLocalize,
  ResourceGraphNodeNavigation,
  ResourceGraphProjectedResource,
  ResourceGraphTreeNodeModel,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "./resourceGraphTreeTypes";

export type ResourceGraphChildren =
  | ResourceGraphTreeNodeModel[]
  | (() => Promise<ResourceGraphTreeNodeModel[]>);

export interface ResourceGraphNodeOptions {
  readonly description?: string;
  readonly resourceUri?: ResourceGraphUriLike;
  readonly navigation?: ResourceGraphNodeNavigation;
  readonly resource?: ResourceGraphProjectedResource;
  readonly children?: ResourceGraphChildren;
  readonly icon?: string;
  readonly contextValue?: string;
  readonly tooltip?: string;
}

export function createNode(
  label: string,
  collapsibleState: ResourceGraphCollapsibleState,
  options: ResourceGraphNodeOptions = {}
): ResourceGraphTreeNodeModel {
  const getChildren = toChildrenProvider(options.children);
  return {
    label,
    collapsibleState,
    description: options.description,
    resourceUri: options.resourceUri,
    navigation: options.navigation,
    resource: options.resource,
    materializationState: options.resource?.producer.materializationState,
    icon: options.icon ?? "file",
    contextValue: options.contextValue,
    tooltip: options.tooltip ?? options.resourceUri?.fsPath,
    getChildren
  };
}

export function createEmptyNode(label: string): ResourceGraphTreeNodeModel {
  return createNode(label, "none", { icon: "circle-slash" });
}

/** Collapsible group whose description is the child count; empty groups render `emptyNode`. */
export function createCountedGroup(
  label: string,
  icon: string,
  nodes: readonly ResourceGraphTreeNodeModel[],
  emptyNode: ResourceGraphTreeNodeModel
): ResourceGraphTreeNodeModel {
  return createNode(label, nodes.length > 0 ? "collapsed" : "none", {
    description: nodes.length.toString(),
    children: nodes.length > 0 ? [...nodes] : [emptyNode],
    icon
  });
}

export function createAlreadyShownNode(
  uri: ResourceGraphUriLike,
  localize: ResourceGraphLocalize
): ResourceGraphTreeNodeModel {
  return createNode(getResourcePathLabel(uri), "none", {
    description: localize("already shown"),
    resourceUri: uri,
    navigation: { kind: "resourceUri", uri },
    icon: getResourceIcon(uri.fsPath),
    contextValue: classifyResourceGraphPreview(uri.fsPath)
  });
}

export function producerResourceIdentity(resource: ResourceGraphProjectedResource): string {
  return `producer:${resource.producer.producerId}`;
}

export async function visitGeneratedResourceOnce(
  visitedResources: ReadonlySet<string>,
  resource: ResourceGraphProjectedResource,
  createChildren: (nextVisitedResources: ReadonlySet<string>) => Promise<ResourceGraphTreeNodeModel[]>,
  localize: ResourceGraphLocalize
): Promise<ResourceGraphTreeNodeModel[]> {
  const identity = producerResourceIdentity(resource);
  if (visitedResources.has(identity)) {
    return [createNode(generatedResourceLabel(resource), "none", {
      description: localize("already shown"),
      navigation: {
        kind: "producer",
        producerId: resource.producer.producerId,
        target: resource.target
      },
      resource,
      icon: getGeneratedResourceIcon(resource.target.kind),
      contextValue: generatedResourceContext(resource),
      tooltip: generatedResourceTooltip(resource)
    })];
  }
  const nextVisitedResources = new Set(visitedResources);
  nextVisitedResources.add(identity);
  return createChildren(nextVisitedResources);
}

export async function visitResourceOnce(
  visitedResources: ReadonlySet<string>,
  uri: ResourceGraphUriLike,
  createChildren: (nextVisitedResources: ReadonlySet<string>) => Promise<ResourceGraphTreeNodeModel[]>,
  localize: ResourceGraphLocalize
): Promise<ResourceGraphTreeNodeModel[]> {
  if (visitedResources.has(resourceUriKey(uri))) {
    return [createAlreadyShownNode(uri, localize)];
  }
  const nextVisitedResources = new Set(visitedResources);
  nextVisitedResources.add(resourceUriKey(uri));
  return createChildren(nextVisitedResources);
}

export interface ResourceGraphReferenceSourceGroup {
  sourceUri: ResourceGraphUriLike;
  sourceResource?: ResourceGraphProjectedResource;
  references: ResourceGraphTreeResolvedReference[];
}

export function groupReferencesBySource(
  references: readonly ResourceGraphTreeResolvedReference[]
): ResourceGraphReferenceSourceGroup[] {
  const groups = new Map<string, ResourceGraphReferenceSourceGroup>();
  for (const reference of references) {
    const key = reference.sourceResource
      ? producerResourceIdentity(reference.sourceResource)
      : resourceUriKey(reference.sourceUri);
    const group = groups.get(key);
    if (group) {
      group.references.push(reference);
    } else {
      groups.set(key, {
        sourceUri: reference.sourceUri,
        sourceResource: reference.sourceResource,
        references: [reference]
      });
    }
  }
  return [...groups.values()];
}

export function isOnlyEmptyNode(nodes: readonly ResourceGraphTreeNodeModel[]): boolean {
  return nodes.length === 1 && nodes[0].icon === "circle-slash";
}

export function compareNodes(left: ResourceGraphTreeNodeModel, right: ResourceGraphTreeNodeModel): number {
  return left.label.localeCompare(right.label);
}

function toChildrenProvider(children: ResourceGraphChildren | undefined): () => Promise<ResourceGraphTreeNodeModel[]> {
  return typeof children === "function"
    ? children
    : () => Promise.resolve(children ?? []);
}
