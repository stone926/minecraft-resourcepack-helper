import * as path from "node:path";
import {
  getAssetResource,
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  resourceUriKey
} from "../utils/resourceGraphSearch";
import type { ResourceReference, ResourceReferenceDocument } from "../utils/resourceReferences/types";
import { classifyResourceGraphPreview, type ResourceGraphPreviewContext } from "./resourceGraphPreviewClassifier";

export type ResourceGraphCollapsibleState = "none" | "collapsed" | "expanded";

export interface ResourceGraphUriLike {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}

export interface ResourceGraphTreeDocument extends ResourceReferenceDocument {
  readonly uri: ResourceGraphUriLike;
}

export interface ResourceGraphTreeResolvedReference {
  readonly reference: ResourceReference;
  readonly sourceUri: ResourceGraphUriLike;
  readonly targetUri: ResourceGraphUriLike | null;
}

export interface ResourceGraphTreeModelHost {
  getBlockstateUris(): Promise<readonly ResourceGraphUriLike[]>;
  getReferences(document: ResourceGraphTreeDocument): readonly ResourceGraphTreeResolvedReference[];
  getIncomingReferences(uri: ResourceGraphUriLike): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getChildModelReferences(uri: ResourceGraphUriLike): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  loadDocument(uri: ResourceGraphUriLike): Promise<ResourceGraphTreeDocument>;
}

export interface ResourceGraphTreeNodeModel {
  readonly label: string;
  readonly collapsibleState: ResourceGraphCollapsibleState;
  readonly description?: string;
  readonly resourceUri?: ResourceGraphUriLike;
  readonly icon: string;
  readonly contextValue?: ResourceGraphPreviewContext;
  readonly tooltip?: string;
  getChildren(): Promise<ResourceGraphTreeNodeModel[]>;
}

export type ResourceGraphLocalize = (message: string, ...args: Array<string | number>) => string;

type ResourceGraphChildren = ResourceGraphTreeNodeModel[] | (() => Promise<ResourceGraphTreeNodeModel[]>);

interface ResourceGraphNodeOptions {
  readonly description?: string;
  readonly resourceUri?: ResourceGraphUriLike;
  readonly children?: ResourceGraphChildren;
  readonly icon?: string;
  readonly contextValue?: ResourceGraphPreviewContext;
  readonly tooltip?: string;
}

export class ResourceGraphTreeModel {
  private blocksNode: Promise<ResourceGraphTreeNodeModel> | null = null;

  public constructor(
    private readonly host: ResourceGraphTreeModelHost,
    private readonly localize: ResourceGraphLocalize
  ) { }

  public invalidate(): void {
    this.blocksNode = null;
  }

  public async getRoots(activeDocument: ResourceGraphTreeDocument | null): Promise<ResourceGraphTreeNodeModel[]> {
    return [
      this.createCurrentFileNode(activeDocument),
      await this.createBlocksNode()
    ];
  }

  private createCurrentFileNode(document: ResourceGraphTreeDocument | null): ResourceGraphTreeNodeModel {
    if (!document || !isResourceGraphDocumentPath(document.fileName)) {
      return createNode(this.localize("Current File"), "none", {
        description: this.localize("No resource editor"),
        icon: "file-code"
      });
    }

    return createNode(this.localize("Current File"), "expanded", {
      description: path.basename(document.fileName),
      resourceUri: document.uri,
      children: () => this.createResourceSections(document.uri, new Set(), document),
      icon: getResourceIcon(document.fileName),
      contextValue: classifyResourceGraphPreview(document.fileName)
    });
  }

  private async createBlocksNode(): Promise<ResourceGraphTreeNodeModel> {
    if (!this.blocksNode) {
      this.blocksNode = this.createBlocksNodeCore().catch(error => {
        this.blocksNode = null;
        throw error;
      });
    }
    return this.blocksNode;
  }

  private async createBlocksNodeCore(): Promise<ResourceGraphTreeNodeModel> {
    const blockNodes = (await this.host.getBlockstateUris()).map(uri => this.createResourceNode(uri, new Set(), {
      label: path.basename(uri.fsPath, ".json"),
      icon: "symbol-structure"
    }));
    blockNodes.sort(compareNodes);
    return createNode(this.localize("Blocks"), blockNodes.length > 0 ? "collapsed" : "none", {
      description: blockNodes.length.toString(),
      children: blockNodes,
      icon: "symbol-namespace"
    });
  }

  private createResourceNode(
    uri: ResourceGraphUriLike,
    visitedResources: ReadonlySet<string>,
    options: {
      readonly label?: string;
      readonly description?: string;
      readonly icon?: string;
      readonly document?: ResourceGraphTreeDocument;
    } = {}
  ): ResourceGraphTreeNodeModel {
    return createNode(options.label ?? getResourcePathLabel(uri), "collapsed", {
      description: options.description,
      resourceUri: uri,
      children: () => this.createResourceSections(uri, visitedResources, options.document),
      icon: options.icon ?? getResourceIcon(uri.fsPath),
      contextValue: classifyResourceGraphPreview(uri.fsPath)
    });
  }

  private async createResourceSections(
    uri: ResourceGraphUriLike,
    visitedResources: ReadonlySet<string>,
    documentOverride?: ResourceGraphTreeDocument
  ): Promise<ResourceGraphTreeNodeModel[]> {
    return visitResourceOnce(visitedResources, uri, async nextVisitedResources => {
      const document = await this.tryLoadResourceDocument(uri, documentOverride);
      const nodes = [
        this.createOutgoingReferencesGroup(nextVisitedResources, document),
        this.createIncomingReferencesGroup(uri, nextVisitedResources)
      ];
      if (document && isModelDocumentPath(uri.fsPath)) {
        nodes.push(this.createModelInheritanceGroup(uri, document));
      }
      return nodes;
    }, this.localize);
  }

  private createOutgoingReferencesGroup(
    visitedResources: ReadonlySet<string>,
    document: ResourceGraphTreeDocument | null
  ): ResourceGraphTreeNodeModel {
    const references = document ? this.host.getReferences(document) : [];
    const referenceNodes = references.map(reference => this.createOutgoingReferenceNode(reference, visitedResources));
    return createNode(this.localize("References"), referenceNodes.length > 0 ? "collapsed" : "none", {
      description: referenceNodes.length.toString(),
      children: referenceNodes.length > 0
        ? referenceNodes
        : [createEmptyNode(this.localize("No references"))],
      icon: "arrow-right"
    });
  }

  private createOutgoingReferenceNode(
    resolvedReference: ResourceGraphTreeResolvedReference,
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
    const reference = resolvedReference.reference;
    if (reference.value.startsWith("#")) {
      return createNode(getReferenceLabel(reference, this.localize), "none", {
        description: this.localize("texture variable"),
        icon: "symbol-variable"
      });
    }
    if (!resolvedReference.targetUri) {
      return createNode(getReferenceLabel(reference, this.localize), "none", {
        description: this.localize("missing"),
        icon: "warning"
      });
    }
    return this.createResourceNode(resolvedReference.targetUri, visitedResources, {
      label: getReferenceLabel(reference, this.localize),
      description: getResourcePathLabel(resolvedReference.targetUri),
      icon: getReferenceIcon(reference)
    });
  }

  private createIncomingReferencesGroup(
    uri: ResourceGraphUriLike,
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Referenced By"), "collapsed", {
      children: () => this.createIncomingReferenceNodes(uri, visitedResources),
      icon: "arrow-left"
    });
  }

  private async createIncomingReferenceNodes(
    uri: ResourceGraphUriLike,
    visitedResources: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const groups = groupReferencesBySource(await this.host.getIncomingReferences(uri));
    if (groups.length === 0) {
      return [createEmptyNode(this.localize("No incoming references"))];
    }
    const nodes = groups.map(group => this.createResourceNode(group.sourceUri, visitedResources, {
      description: group.references.length === 1
        ? getReferenceLabel(group.references[0].reference, this.localize)
        : this.localize("{0} references", group.references.length),
      icon: getResourceIcon(group.sourceUri.fsPath)
    }));
    nodes.sort(compareNodes);
    return nodes;
  }

  private createModelInheritanceGroup(
    uri: ResourceGraphUriLike,
    document: ResourceGraphTreeDocument
  ): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Model Inheritance"), "collapsed", {
      children: () => this.createModelInheritanceNodes(uri, document),
      icon: "type-hierarchy"
    });
  }

  private async createModelInheritanceNodes(
    uri: ResourceGraphUriLike,
    document: ResourceGraphTreeDocument
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const visitedModels = new Set<string>([resourceUriKey(uri)]);
    const parentNodes = await this.createParentModelNodes(document, visitedModels);
    const childNodes = await this.createChildModelNodes(uri, visitedModels);
    return [
      createNode(this.localize("Parent Models"), parentNodes.length > 0 ? "collapsed" : "none", {
        description: parentNodes.length.toString(),
        children: parentNodes.length > 0 ? parentNodes : [createEmptyNode(this.localize("No parent model"))],
        icon: "arrow-up"
      }),
      createNode(this.localize("Child Models"), childNodes.length > 0 ? "collapsed" : "none", {
        description: childNodes.length.toString(),
        children: childNodes.length > 0 ? childNodes : [createEmptyNode(this.localize("No child models"))],
        icon: "arrow-down"
      })
    ];
  }

  private async createParentModelNodes(
    document: ResourceGraphTreeDocument,
    visitedModels: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const parents = this.host.getReferences(document)
      .filter(reference => reference.reference.relationship === "modelParent");
    const nodes = await Promise.all(parents.map(reference => reference.targetUri
      ? this.createParentModelNode(reference.targetUri, reference.reference, visitedModels)
      : Promise.resolve(createNode(getReferenceLabel(reference.reference, this.localize), "none", {
        description: this.localize("missing"),
        icon: "warning"
      }))));
    nodes.sort(compareNodes);
    return nodes;
  }

  private async createParentModelNode(
    uri: ResourceGraphUriLike,
    reference: ResourceReference,
    visitedModels: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel> {
    const alreadyVisited = visitedModels.has(resourceUriKey(uri));
    const hasParents = !alreadyVisited && await this.hasParentModelNodes(uri);
    return createNode(getReferenceLabel(reference, this.localize), hasParents ? "collapsed" : "none", {
      description: alreadyVisited ? this.localize("already shown") : getResourcePathLabel(uri),
      resourceUri: uri,
      children: () => visitResourceOnce(visitedModels, uri, async nextVisited => {
        const document = await this.tryLoadResourceDocument(uri);
        if (!document) {
          return [];
        }
        const nodes = await this.createParentModelNodes(document, nextVisited);
        return nodes.length > 0 ? nodes : [createEmptyNode(this.localize("No parent model"))];
      }, this.localize),
      icon: "file-code",
      contextValue: classifyResourceGraphPreview(uri.fsPath)
    });
  }

  private async hasParentModelNodes(uri: ResourceGraphUriLike): Promise<boolean> {
    const document = await this.tryLoadResourceDocument(uri);
    return document !== null && this.host.getReferences(document)
      .some(reference => reference.reference.relationship === "modelParent");
  }

  private async createChildModelNodes(
    uri: ResourceGraphUriLike,
    visitedModels: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const groups = groupReferencesBySource(await this.host.getChildModelReferences(uri));
    const nodes = await Promise.all(groups.map(group =>
      this.createChildModelNode(group.sourceUri, group.references, visitedModels)
    ));
    nodes.sort(compareNodes);
    return nodes;
  }

  private async createChildModelNode(
    uri: ResourceGraphUriLike,
    references: readonly ResourceGraphTreeResolvedReference[],
    visitedModels: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel> {
    const alreadyVisited = visitedModels.has(resourceUriKey(uri));
    const hasChildren = !alreadyVisited && (await this.host.getChildModelReferences(uri)).length > 0;
    return createNode(getResourcePathLabel(uri), hasChildren ? "collapsed" : "none", {
      description: alreadyVisited
        ? this.localize("already shown")
        : references.length === 1
          ? getReferenceLabel(references[0].reference, this.localize)
          : this.localize("{0} references", references.length),
      resourceUri: uri,
      children: () => visitResourceOnce(visitedModels, uri, async nextVisited => {
        const nodes = await this.createChildModelNodes(uri, nextVisited);
        return nodes.length > 0 ? nodes : [createEmptyNode(this.localize("No child models"))];
      }, this.localize),
      icon: "file-code",
      contextValue: classifyResourceGraphPreview(uri.fsPath)
    });
  }

  private async tryLoadResourceDocument(
    uri: ResourceGraphUriLike,
    documentOverride?: ResourceGraphTreeDocument
  ): Promise<ResourceGraphTreeDocument | null> {
    if (documentOverride && resourceUriKey(documentOverride.uri) === resourceUriKey(uri)) {
      return documentOverride;
    }
    if (!isResourceGraphDocumentPath(uri.fsPath)) {
      return null;
    }
    try {
      return await this.host.loadDocument(uri);
    } catch {
      return null;
    }
  }
}

function createNode(
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
    icon: options.icon ?? "file",
    contextValue: options.contextValue,
    tooltip: options.tooltip ?? options.resourceUri?.fsPath,
    getChildren
  };
}

function createEmptyNode(label: string): ResourceGraphTreeNodeModel {
  return createNode(label, "none", { icon: "circle-slash" });
}

function createAlreadyShownNode(
  uri: ResourceGraphUriLike,
  localize: ResourceGraphLocalize
): ResourceGraphTreeNodeModel {
  return createNode(getResourcePathLabel(uri), "none", {
    description: localize("already shown"),
    resourceUri: uri,
    icon: getResourceIcon(uri.fsPath),
    contextValue: classifyResourceGraphPreview(uri.fsPath)
  });
}

async function visitResourceOnce(
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

function groupReferencesBySource(references: readonly ResourceGraphTreeResolvedReference[]): Array<{
  sourceUri: ResourceGraphUriLike;
  references: ResourceGraphTreeResolvedReference[];
}> {
  const groups = new Map<string, { sourceUri: ResourceGraphUriLike; references: ResourceGraphTreeResolvedReference[] }>();
  for (const reference of references) {
    const key = resourceUriKey(reference.sourceUri);
    const group = groups.get(key);
    if (group) {
      group.references.push(reference);
    } else {
      groups.set(key, { sourceUri: reference.sourceUri, references: [reference] });
    }
  }
  return [...groups.values()];
}

function getReferenceLabel(reference: ResourceReference, localize: ResourceGraphLocalize): string {
  switch (reference.kind) {
    case "model": return localize("model: {0}", reference.value);
    case "texture": return localize("texture: {0}", reference.value);
    case "textureDirectory": return localize("texture directory: {0}", reference.value);
    case "font": return localize("font: {0}", reference.value);
    case "fontFile": return localize("font file: {0}", reference.value);
    case "shader": return localize("shader: {0}", reference.value);
    default: return localize("sound: {0}", reference.value);
  }
}

function getReferenceIcon(reference: ResourceReference): string {
  if (reference.kind === "textureDirectory") {
    return "folder";
  }
  if (["model", "shader", "font", "fontFile"].includes(reference.kind)) {
    return "file-code";
  }
  return "file-media";
}

function getResourceIcon(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".json") {
    return isModelDocumentPath(fileName) ? "file-code" : "json";
  }
  if (extension === ".png" || extension === ".ogg") {
    return "file-media";
  }
  if (extension === ".vsh" || extension === ".fsh" || extension === ".glsl") {
    return "file-code";
  }
  return extension ? "file" : "folder";
}

function getResourcePathLabel(uri: ResourceGraphUriLike): string {
  const resource = getAssetResource(uri.fsPath);
  return resource ? `${resource.namespace}:${resource.resourcePath}` : path.basename(uri.fsPath);
}

function compareNodes(left: ResourceGraphTreeNodeModel, right: ResourceGraphTreeNodeModel): number {
  return left.label.localeCompare(right.label);
}

function toChildrenProvider(children: ResourceGraphChildren | undefined): () => Promise<ResourceGraphTreeNodeModel[]> {
  return typeof children === "function"
    ? children
    : () => Promise.resolve(children ?? []);
}
