import * as path from "node:path";
import {
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  resourceUriKey
} from "../utils/resourceGraphSearch";
import type { ResourceReference } from "../utils/resourceReferences/types";
import { rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
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
import {
  getFocusedResourceContext,
  getGeneratedResourceIcon,
  getReferenceIcon,
  getReferenceLabel,
  getResourceIcon,
  getResourcePathLabel,
  referenceDescription
} from "./resourceGraphNodePresentation";
import {
  compareNodes,
  createCountedGroup,
  createEmptyNode,
  createNode,
  groupReferencesBySource,
  isOnlyEmptyNode,
  producerResourceIdentity,
  visitGeneratedResourceOnce,
  visitResourceOnce
} from "./resourceGraphTreeNodeFactory";
import type {
  ResourceGraphDocumentProjection,
  ResourceGraphLocalize,
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

export class ResourceGraphTreeModel {
  private blockChildren: Promise<ResourceGraphTreeNodeModel[]> | null = null;

  public constructor(
    private readonly host: ResourceGraphTreeModelHost,
    private readonly localize: ResourceGraphLocalize
  ) { }

  public invalidate(): void {
    this.blockChildren = null;
  }

  public async getRoots(
    activeDocument: ResourceGraphTreeDocument | null,
    focusedResource?: ResourceGraphProjectedResource
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const projection = !focusedResource && activeDocument
      ? await this.host.getDocumentProjection(activeDocument)
      : null;
    return [
      focusedResource
        ? this.createFocusedResourceNode(focusedResource)
        : this.createCurrentFileNode(activeDocument, projection),
      this.createBlocksNode()
    ];
  }

  private createFocusedResourceNode(
    resource: ResourceGraphProjectedResource
  ): ResourceGraphTreeNodeModel {
    const generated = resource.producer.origin === "generated";
    const resourceUri = generated
      ? generatedPreviewUri(resource.producer)
      : resource.producer.physicalOrigins[0]
        ? serializedUriLike(resource.producer.physicalOrigins[0].uri)
        : undefined;
    const identity = producerResourceIdentity(resource);
    const visitedResources = new Set([identity]);
    if (!generated && resourceUri) {
      visitedResources.add(resourceUriKey(resourceUri));
    }
    return createNode(this.localize("Selected Resource"), "expanded", {
      description: `${resource.target.kind} ${resource.target.id}`,
      resourceUri,
      navigation: {
        kind: "producer",
        producerId: resource.producer.producerId,
        target: resource.target
      },
      resource,
      children: () => this.createProducerResourceSections(
        resource,
        visitedResources
      ),
      icon: getGeneratedResourceIcon(resource.target.kind),
      contextValue: getFocusedResourceContext(resource, resourceUri),
      tooltip: generatedResourceTooltip(resource)
    });
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

    const generatedProjection = projection.providerIds.includes(rsglGeneratedProviderId);
    const generatedCoverage = projection.providerCoverages
      .find(item => item.providerId === rsglGeneratedProviderId)
      ?.coverage ?? projection.coverage;
    return createNode(this.localize("Current File"), "expanded", {
      description: path.basename(document.fileName),
      resourceUri: document.uri,
      navigation: { kind: "resourceUri", uri: document.uri },
      children: generatedProjection
        ? this.createGeneratedDocumentGroups(projection, generatedCoverage)
        : () => this.createResourceSections(document.uri, new Set(), document),
      icon: getResourceIcon(document.fileName),
      contextValue: generatedProjection ? "resourceGraphRsglDocument" : classifyResourceGraphPreview(document.fileName)
    });
  }

  private createGeneratedDocumentGroups(
    projection: ResourceGraphDocumentProjection,
    generatedCoverage: ResourceGraphDocumentProjection["coverage"]
  ): ResourceGraphTreeNodeModel[] {
    const groups = [
      this.createGeneratedProjectionGroup(
        this.localize("Generated Resources"),
        "sparkle",
        projection.resources
      ),
      this.createGeneratedProjectionGroup(
        this.localize("Contributes To"),
        "references",
        projection.contributesTo
      )
    ];
    return generatedCoverage === "authoritative"
      ? groups
      : [
          createNode(
            generatedCoverage === "partial"
              ? this.localize("RSGL resource snapshot is partial")
              : this.localize("RSGL resource snapshot is unavailable"),
            "none",
            { icon: generatedCoverage === "partial" ? "warning" : "question" }
          ),
          ...groups
        ];
  }

  private createGeneratedProjectionGroup(
    label: string,
    icon: string,
    resources: readonly ResourceGraphProjectedResource[]
  ): ResourceGraphTreeNodeModel {
    const children = resources.map(resource => this.createGeneratedResourceNode(resource, new Set()));
    children.sort(compareNodes);
    return createCountedGroup(label, icon, children, createEmptyNode(this.localize("No generated resources")));
  }

  private createBlocksNode(): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Blocks"), "collapsed", {
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
    const identity = producerResourceIdentity(resource);
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
        nextVisited => this.createProducerResourceSections(resource, nextVisited),
        this.localize
      ),
      icon: options.icon ?? getGeneratedResourceIcon(resource.target.kind),
      contextValue: generatedResourceContext(resource),
      tooltip: generatedResourceTooltip(resource)
    });
  }

  private async createProducerResourceSections(
    resource: ResourceGraphProjectedResource,
    visitedResources: ReadonlySet<string>
  ): Promise<ResourceGraphTreeNodeModel[]> {
    const nodes = [
      this.createProducerOriginsGroup(resource),
      await this.createProducerOutgoingReferencesGroup(resource, visitedResources),
      this.createProducerIncomingReferencesGroup(resource, visitedResources)
    ];
    if (resource.target.kind === "model") {
      nodes.push(this.createProducerModelInheritanceGroup(resource, visitedResources));
    }
    return nodes;
  }

  private createProducerOriginsGroup(resource: ResourceGraphProjectedResource): ResourceGraphTreeNodeModel {
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
        description: locationDescription(location, producer.origin === "generated"
          ? this.localize("materialized")
          : this.localize("Handwritten")),
        resourceUri: serializedUriLike(location.uri),
        navigation: { kind: "location", location },
        icon: "output",
        contextValue: "resourceGraphMaterializedOrigin",
        tooltip: location.uri
      }))
    ];
    return createCountedGroup(this.localize("Origins"), "source-control", origins, createEmptyNode(this.localize("No origins")));
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
    return createCountedGroup(this.localize("References"), "arrow-right", referenceNodes, createEmptyNode(this.localize("No references")));
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
      return this.createMissingReferenceNode(reference);
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

  private createMissingReferenceNode(reference: ResourceReference): ResourceGraphTreeNodeModel {
    return createNode(getReferenceLabel(reference, this.localize), "none", {
      description: this.localize("missing"),
      icon: "warning",
      contextValue: "resourceGraphMissing"
    });
  }

  private createIncomingReferencesGroup(
    uri: ResourceGraphUriLike,
    visitedResources: ReadonlySet<string>
  ): ResourceGraphTreeNodeModel {
    return createNode(this.localize("Referenced By"), "collapsed", {
      children: async () => this.createIncomingReferenceNodesFrom(
        await this.host.getIncomingReferences(uri),
        visitedResources
      ),
      icon: "arrow-left"
    });
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
          description: this.describeReferenceGroup(group.references)
        })
      : this.createResourceNode(group.sourceUri, visitedResources, {
        description: this.describeReferenceGroup(group.references),
        icon: getResourceIcon(group.sourceUri.fsPath)
      }));
    nodes.sort(compareNodes);
    return nodes;
  }

  private describeReferenceGroup(references: readonly ResourceGraphTreeResolvedReference[]): string {
    return references.length === 1
      ? referenceDescription(references[0], this.localize)
      : this.localize("{0} references", references.length);
  }

  private createProducerModelInheritanceGroup(
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
          createCountedGroup(this.localize("Parent Models"), "arrow-up", parents, createEmptyNode(this.localize("No parent model"))),
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
      createCountedGroup(this.localize("Parent Models"), "arrow-up", parentNodes, createEmptyNode(this.localize("No parent model"))),
      createCountedGroup(this.localize("Child Models"), "arrow-down", childNodes, createEmptyNode(this.localize("No child models")))
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
        : Promise.resolve(this.createMissingReferenceNode(reference.reference));
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
          description: this.describeReferenceGroup(group.references),
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
