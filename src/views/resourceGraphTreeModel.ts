import * as path from "node:path";
import {
  getAssetResource,
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  resourceUriKey
} from "../utils/resourceGraphSearch";
import type { ResourceReference } from "../utils/resourceReferences/types";
import { classifyResourceGraphPreview } from "./resourceGraphPreviewClassifier";
import {
  generatedPreviewUri,
  generatedResourceContext,
  generatedResourceDescription,
  generatedResourceLabel,
  generatedResourceTooltip,
  locationDescription,
  locationLabel,
  serializedUriLike
} from "./resourceGraphGeneratedPresentation";
import type {
  ResourceGraphCollapsibleState,
  ResourceGraphDocumentProjection,
  ResourceGraphLocalize,
  ResourceGraphNodeNavigation,
  ResourceGraphProjectedResource,
  ResourceGraphTreeDocument,
  ResourceGraphTreeModelHost,
  ResourceGraphTreeNodeModel,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "./resourceGraphTreeTypes";

export type {
  ResourceGraphBlockInventory,
  ResourceGraphCollapsibleState,
  ResourceGraphDocumentProjection,
  ResourceGraphLocalize,
  ResourceGraphNodeNavigation,
  ResourceGraphProjectedResource,
  ResourceGraphTreeDocument,
  ResourceGraphTreeModelHost,
  ResourceGraphTreeNodeModel,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "./resourceGraphTreeTypes";

type ResourceGraphChildren = ResourceGraphTreeNodeModel[] | (() => Promise<ResourceGraphTreeNodeModel[]>);

interface ResourceGraphNodeOptions {
  readonly description?: string;
  readonly resourceUri?: ResourceGraphUriLike;
  readonly navigation?: ResourceGraphNodeNavigation;
  readonly resource?: ResourceGraphProjectedResource;
  readonly children?: ResourceGraphChildren;
  readonly icon?: string;
  readonly contextValue?: string;
  readonly tooltip?: string;
}

export class ResourceGraphTreeModel {
  private blockChildren: Promise<ResourceGraphTreeNodeModel[]> | null = null;

  public constructor(
    private readonly host: ResourceGraphTreeModelHost,
    private readonly localize: ResourceGraphLocalize
  ) { }

  public invalidate(): void {
    this.blockChildren = null;
  }

  public async getRoots(activeDocument: ResourceGraphTreeDocument | null): Promise<ResourceGraphTreeNodeModel[]> {
    const projection = activeDocument
      ? await this.host.getDocumentProjection(activeDocument)
      : null;
    return [
      this.createCurrentFileNode(activeDocument, projection),
      this.createBlocksNode()
    ];
  }

  private createCurrentFileNode(
    document: ResourceGraphTreeDocument | null,
    projection: ResourceGraphDocumentProjection | null
  ): ResourceGraphTreeNodeModel {
    if (!document || !projection?.applicable) {
      return createNode(this.localize("Current File"), "none", {
        description: this.localize("No resource editor"),
        icon: "file-code"
      });
    }

    const generatedProjection = projection.providerIds.includes("rsgl");
    return createNode(this.localize("Current File"), "expanded", {
      description: path.basename(document.fileName),
      resourceUri: document.uri,
      navigation: { kind: "resourceUri", uri: document.uri },
      children: generatedProjection
        ? this.createGeneratedDocumentGroups(projection)
        : () => this.createResourceSections(document.uri, new Set(), document),
      icon: getResourceIcon(document.fileName),
      contextValue: generatedProjection ? "resourceGraphRsglDocument" : classifyResourceGraphPreview(document.fileName)
    });
  }

  private createGeneratedDocumentGroups(
    projection: ResourceGraphDocumentProjection
  ): ResourceGraphTreeNodeModel[] {
    return [
      this.createGeneratedProjectionGroup(
        this.localize("Generated Resources"),
        "sparkle",
        projection.resources,
        projection.coverage
      ),
      this.createGeneratedProjectionGroup(
        this.localize("Contributes To"),
        "references",
        projection.contributesTo,
        projection.coverage
      )
    ];
  }

  private createGeneratedProjectionGroup(
    label: string,
    icon: string,
    resources: readonly ResourceGraphProjectedResource[],
    coverage: ResourceGraphDocumentProjection["coverage"]
  ): ResourceGraphTreeNodeModel {
    const children = resources.map(resource => this.createGeneratedResourceNode(resource, new Set()));
    children.sort(compareNodes);
    if (coverage !== "authoritative") {
      children.unshift(createNode(
        coverage === "partial"
          ? this.localize("RSGL resource snapshot is partial")
          : this.localize("RSGL resource snapshot is unavailable"),
        "none",
        { icon: coverage === "partial" ? "warning" : "question" }
      ));
    }
    return createNode(this.localize(label), children.length > 0 ? "collapsed" : "none", {
      description: resources.length.toString(),
      children: children.length > 0 ? children : [createEmptyNode(this.localize("No generated resources"))],
      icon
    });
  }

  private createBlocksNode(): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Blocks"), "collapsed", {
      description: this.localize("unknown"),
      children: () => this.getBlockChildren(),
      icon: "symbol-namespace",
      tooltip: this.localize("Load block inventory when expanded")
    });
  }

  private getBlockChildren(): Promise<ResourceGraphTreeNodeModel[]> {
    if (!this.blockChildren) {
      this.blockChildren = this.createBlockChildren().catch(error => {
        this.blockChildren = null;
        throw error;
      });
    }
    return this.blockChildren;
  }

  private async createBlockChildren(): Promise<ResourceGraphTreeNodeModel[]> {
    const inventory = await this.host.getBlockstateInventory();
    if (inventory.status === "unknown") {
      return [createNode(this.localize("Block inventory unavailable"), "none", {
        description: inventory.reason,
        icon: "question"
      })];
    }
    const blockNodes = inventory.uris.map(uri => this.createResourceNode(uri, new Set(), {
      label: path.basename(uri.fsPath, ".json"),
      icon: "symbol-structure"
    }));
    for (const resource of inventory.resources ?? []) {
      blockNodes.push(this.createGeneratedResourceNode(resource, new Set(), {
        label: `${resource.target.id} [RSGL]`,
        icon: "symbol-structure"
      }));
    }
    blockNodes.sort(compareNodes);
    if (inventory.status === "partial") {
      blockNodes.unshift(createNode(this.localize("Block inventory is partial"), "none", {
        description: inventory.reason,
        icon: "warning"
      }));
    }
    return blockNodes.length > 0
      ? blockNodes
      : [createEmptyNode(this.localize("No blocks"))];
  }

  private createGeneratedResourceNode(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>,
    options: { label?: string; icon?: string; description?: string } = {}
  ): ResourceGraphTreeNodeModel {
    const previewUri = generatedPreviewUri(resource.producer);
    const identity = generatedResourceIdentity(resource);
    const alreadyVisited = visitedResources.has(identity);
    return createNode(options.label ?? generatedResourceLabel(resource), alreadyVisited ? "none" : "collapsed", {
      description: options.description ?? (alreadyVisited
        ? this.localize("already shown")
        : generatedResourceDescription(resource)),
      resourceUri: previewUri,
      navigation: {
        kind: "producer",
        producerId: resource.producer.producerId,
        target: resource.target
      },
      resource,
      children: () => visitGeneratedResourceOnce(
        visitedResources,
        resource,
        nextVisited => this.createGeneratedResourceSections(resource, nextVisited),
        this.localize
      ),
      icon: options.icon ?? getGeneratedResourceIcon(resource.target.kind),
      contextValue: generatedResourceContext(resource),
      tooltip: generatedResourceTooltip(resource)
    });
  }

  private async createGeneratedResourceSections(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const nodes = [
      this.createGeneratedOriginsGroup(resource),
      await this.createProducerOutgoingReferencesGroup(resource, visitedResources),
      this.createProducerIncomingReferencesGroup(resource, visitedResources)
    ];
    if (resource.target.kind === "model") {
      nodes.push(this.createGeneratedModelInheritanceGroup(resource, visitedResources));
    }
    return nodes;
  }

  private createGeneratedOriginsGroup(resource: ResourceGraphProjectedResource): ResourceGraphTreeNodeModel {
    const producer = resource.producer;
    const origins = [
      ...producer.sourceOrigins.map((location, index) => createNode(locationLabel(location), "none", {
        description: locationDescription(location, index === 0
          ? this.localize("primary source")
          : this.localize("contributor")),
        resourceUri: serializedUriLike(location.uri),
        navigation: { kind: "location", location },
        icon: "file-code",
        contextValue: "resourceGraphGeneratedSource",
        tooltip: location.uri
      })),
      ...producer.physicalOrigins.map(location => createNode(locationLabel(location), "none", {
        description: locationDescription(location, this.localize("materialized")),
        resourceUri: serializedUriLike(location.uri),
        navigation: { kind: "location", location },
        icon: "output",
        contextValue: "resourceGraphMaterializedOrigin",
        tooltip: location.uri
      }))
    ];
    return createNode(this.localize("Origins"), origins.length > 0 ? "collapsed" : "none", {
      description: origins.length.toString(),
      children: origins.length > 0 ? origins : [createEmptyNode(this.localize("No origins"))],
      icon: "source-control"
    });
  }

  private async createProducerOutgoingReferencesGroup(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel> {
    const references = await this.host.getProducerReferences(resource);
    return this.createOutgoingReferencesGroupFrom(references, visitedResources);
  }

  private createProducerIncomingReferencesGroup(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Referenced By"), "collapsed", {
      children: async () => this.createIncomingReferenceNodesFrom(
        await this.host.getProducerIncomingReferences(resource),
        visitedResources
      ),
      icon: "arrow-left"
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
      navigation: { kind: "resourceUri", uri },
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
        await this.createOutgoingReferencesGroup(nextVisitedResources, document),
        this.createIncomingReferencesGroup(uri, nextVisitedResources)
      ];
      if (document && isModelDocumentPath(uri.fsPath)) {
        nodes.push(this.createModelInheritanceGroup(uri, document));
      }
      return nodes;
    }, this.localize);
  }

  private async createOutgoingReferencesGroup(
    visitedResources: ReadonlySet<string>,
    document: ResourceGraphTreeDocument | null
  ): Promise<ResourceGraphTreeNodeModel> {
    const references = document ? await this.host.getReferences(document) : [];
    return this.createOutgoingReferencesGroupFrom(references, visitedResources);
  }

  private createOutgoingReferencesGroupFrom(
    references: readonly ResourceGraphTreeResolvedReference[],
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
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
      if (resolvedReference.targetResource) {
        return this.createGeneratedResourceNode(resolvedReference.targetResource, visitedResources, {
          label: getReferenceLabel(reference, this.localize),
          description: generatedResourceDescription(resolvedReference.targetResource),
          icon: getReferenceIcon(reference)
        });
      }
      return createNode(getReferenceLabel(reference, this.localize), "none", {
        description: this.localize("missing"),
        icon: "warning",
        contextValue: "resourceGraphMissing"
      });
    }
    if (resolvedReference.targetResource?.producer.origin === "generated") {
      return this.createGeneratedResourceNode(resolvedReference.targetResource, visitedResources, {
        label: getReferenceLabel(reference, this.localize),
        description: generatedResourceDescription(resolvedReference.targetResource),
        icon: getReferenceIcon(reference)
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
    return this.createIncomingReferenceNodesFrom(
      await this.host.getIncomingReferences(uri),
      visitedResources
    );
  }

  private createIncomingReferenceNodesFrom(
    references: readonly ResourceGraphTreeResolvedReference[],
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel[] {
    const groups = groupReferencesBySource(references);
    if (groups.length === 0) {
      return [createEmptyNode(this.localize("No incoming references"))];
    }
    const nodes = groups.map(group => group.sourceResource?.producer.origin === "generated"
      ? this.createGeneratedResourceNode(group.sourceResource, visitedResources, {
          description: group.references.length === 1
            ? referenceDescription(group.references[0], this.localize)
            : this.localize("{0} references", group.references.length)
        })
      : this.createResourceNode(group.sourceUri, visitedResources, {
        description: group.references.length === 1
          ? referenceDescription(group.references[0], this.localize)
          : this.localize("{0} references", group.references.length),
        icon: getResourceIcon(group.sourceUri.fsPath)
      }));
    nodes.sort(compareNodes);
    return nodes;
  }

  private createGeneratedModelInheritanceGroup(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Model Inheritance"), "collapsed", {
      children: async () => {
        const parents = (await this.host.getProducerReferences(resource))
          .filter(reference => reference.reference.relationship === "modelParent")
          .map(reference => this.createOutgoingReferenceNode(reference, visitedResources));
        const children = this.createIncomingReferenceNodesFrom(
          await this.host.getProducerChildModelReferences(resource),
          visitedResources
        );
        return [
          createNode(this.localize("Parent Models"), parents.length > 0 ? "collapsed" : "none", {
            description: parents.length.toString(),
            children: parents.length > 0 ? parents : [createEmptyNode(this.localize("No parent model"))],
            icon: "arrow-up"
          }),
          createNode(this.localize("Child Models"), isOnlyEmptyNode(children) ? "none" : "collapsed", {
            description: isOnlyEmptyNode(children) ? "0" : children.length.toString(),
            children,
            icon: "arrow-down"
          })
        ];
      },
      icon: "type-hierarchy"
    });
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
    const parents = (await this.host.getReferences(document))
      .filter(reference => reference.reference.relationship === "modelParent");
    const nodes = await Promise.all(parents.map(reference => {
      if (reference.targetResource?.producer.origin === "generated") {
        return this.createGeneratedResourceNode(reference.targetResource, visitedModels, {
          label: getReferenceLabel(reference.reference, this.localize),
          icon: "file-code"
        });
      }
      return reference.targetUri
        ? this.createParentModelNode(reference.targetUri, reference.reference, visitedModels)
        : Promise.resolve(createNode(getReferenceLabel(reference.reference, this.localize), "none", {
            description: this.localize("missing"),
            icon: "warning",
            contextValue: "resourceGraphMissing"
          }));
    }));
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
      navigation: { kind: "resourceUri", uri },
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
    return document !== null && (await this.host.getReferences(document))
      .some(reference => reference.reference.relationship === "modelParent");
  }

  private async createChildModelNodes(
    uri: ResourceGraphUriLike,
    visitedModels: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const groups = groupReferencesBySource(await this.host.getChildModelReferences(uri));
    const nodes = await Promise.all(groups.map(group => group.sourceResource?.producer.origin === "generated"
      ? Promise.resolve(this.createGeneratedResourceNode(group.sourceResource, visitedModels, {
          description: group.references.length === 1
            ? referenceDescription(group.references[0], this.localize)
            : this.localize("{0} references", group.references.length),
          icon: "file-code"
        }))
      : this.createChildModelNode(group.sourceUri, group.references, visitedModels)
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
      navigation: { kind: "resourceUri", uri },
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
    navigation: options.navigation,
    resource: options.resource,
    materializationState: options.resource?.producer.materializationState,
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
    navigation: { kind: "resourceUri", uri },
    icon: getResourceIcon(uri.fsPath),
    contextValue: classifyResourceGraphPreview(uri.fsPath)
  });
}

async function visitGeneratedResourceOnce(
  visitedResources: ReadonlySet<string>,
  resource: ResourceGraphProjectedResource,
  createChildren: (nextVisitedResources: ReadonlySet<string>) => Promise<ResourceGraphTreeNodeModel[]>,
  localize: ResourceGraphLocalize
): Promise<ResourceGraphTreeNodeModel[]> {
  const identity = generatedResourceIdentity(resource);
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
  sourceResource?: ResourceGraphProjectedResource;
  references: ResourceGraphTreeResolvedReference[];
}> {
  const groups = new Map<string, {
    sourceUri: ResourceGraphUriLike;
    sourceResource?: ResourceGraphProjectedResource;
    references: ResourceGraphTreeResolvedReference[];
  }>();
  for (const reference of references) {
    const key = reference.sourceResource
      ? generatedResourceIdentity(reference.sourceResource)
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

function referenceDescription(
  reference: ResourceGraphTreeResolvedReference,
  localize: ResourceGraphLocalize
): string {
  const label = getReferenceLabel(reference.reference, localize);
  return reference.sourceRange
    ? `${label} · ${reference.sourceRange.start}–${reference.sourceRange.end}`
    : label;
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

function getGeneratedResourceIcon(kind: string): string {
  if (kind === "model" || kind === "blockstate" || kind === "item" || kind === "font") {
    return "file-code";
  }
  if (kind === "texture" || kind === "sound") {
    return "file-media";
  }
  return "symbol-object";
}

function generatedResourceIdentity(resource: ResourceGraphProjectedResource): string {
  return `producer:${resource.producer.producerId}`;
}

function isOnlyEmptyNode(nodes: readonly ResourceGraphTreeNodeModel[]): boolean {
  return nodes.length === 1 && nodes[0].icon === "circle-slash";
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
