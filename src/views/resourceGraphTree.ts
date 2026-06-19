import * as path from "node:path";
import * as vscode from "vscode";
import {
  isModelDocumentPath,
  loadResourceGraphDocument,
  ResourceGraphDocument,
  ResourceGraphIndex,
  resourceUriKey,
  ResolvedResourceReference
} from "../utils/resourceGraph";
import { ResourceReference } from "../utils/resourceReferences";

type ResourceGraphChildren = ResourceGraphNode[] | (() => Promise<ResourceGraphNode[]>);

class ResourceGraphNode extends vscode.TreeItem {
  private readonly childrenProvider: () => Promise<ResourceGraphNode[]>;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: {
      description?: string;
      uri?: vscode.Uri;
      children?: ResourceGraphChildren;
      iconPath?: vscode.ThemeIcon;
      contextValue?: string;
      tooltip?: string | vscode.MarkdownString;
    } = {}
  ) {
    super(label, collapsibleState);
    this.description = options.description;
    this.resourceUri = options.uri;
    this.childrenProvider = toChildrenProvider(options.children);
    this.iconPath = options.iconPath;
    this.contextValue = options.contextValue;
    this.tooltip = options.tooltip ?? options.uri?.fsPath;

    if (options.uri) {
      this.command = {
        command: "vscode.open",
        title: vscode.l10n.t("Open Resource"),
        arguments: [options.uri]
      };
    }
  }

  getChildren(): Promise<ResourceGraphNode[]> {
    return this.childrenProvider();
  }
}

export class ResourceGraphTreeProvider implements vscode.TreeDataProvider<ResourceGraphNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ResourceGraphNode | undefined | null | void>();
  private readonly graphIndex = new ResourceGraphIndex();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.clearRefreshTimer();
    this.graphIndex.invalidate();
    this.onDidChangeTreeDataEmitter.fire();
  }

  refreshSoon(delay = 250): void {
    this.graphIndex.invalidate();
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.onDidChangeTreeDataEmitter.fire();
    }, delay);
  }

  dispose(): void {
    this.clearRefreshTimer();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: ResourceGraphNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ResourceGraphNode): Promise<ResourceGraphNode[]> {
    if (element) {
      return element.getChildren();
    }

    return [
      this.createCurrentFileNode(),
      await this.createBlocksNode()
    ];
  }

  private createCurrentFileNode(): ResourceGraphNode {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "json") {
      return new ResourceGraphNode(
        vscode.l10n.t("Current File"),
        vscode.TreeItemCollapsibleState.None,
        { description: vscode.l10n.t("No JSON editor"), iconPath: new vscode.ThemeIcon("json") }
      );
    }

    return new ResourceGraphNode(
      vscode.l10n.t("Current File"),
      vscode.TreeItemCollapsibleState.Expanded,
      {
        description: path.basename(document.fileName),
        uri: document.uri,
        children: () => this.createResourceSections(document.uri, new Set(), document),
        iconPath: new vscode.ThemeIcon("json")
      }
    );
  }

  private async createBlocksNode(): Promise<ResourceGraphNode> {
    const blockstateUris = await vscode.workspace.findFiles("**/assets/*/blockstates/*.json", "**/node_modules/**");
    const blockNodes = blockstateUris.map(uri => this.createResourceNode(uri, new Set(), {
      label: path.basename(uri.fsPath, ".json"),
      iconPath: new vscode.ThemeIcon("symbol-structure")
    }));
    blockNodes.sort(compareNodes);

    return new ResourceGraphNode(
      vscode.l10n.t("Blocks"),
      blockNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      {
        description: blockNodes.length.toString(),
        children: blockNodes,
        iconPath: new vscode.ThemeIcon("symbol-namespace")
      }
    );
  }

  private createResourceNode(
    uri: vscode.Uri,
    visitedResources: Set<string>,
    options: {
      label?: string;
      description?: string;
      iconPath?: vscode.ThemeIcon;
      document?: ResourceGraphDocument;
    } = {}
  ): ResourceGraphNode {
    return new ResourceGraphNode(
      options.label ?? getResourcePathLabel(uri),
      vscode.TreeItemCollapsibleState.Collapsed,
      {
        description: options.description,
        uri,
        children: () => this.createResourceSections(uri, visitedResources, options.document),
        iconPath: options.iconPath ?? getResourceIcon(uri.fsPath)
      }
    );
  }

  private async createResourceSections(
    uri: vscode.Uri,
    visitedResources: Set<string>,
    documentOverride?: ResourceGraphDocument
  ): Promise<ResourceGraphNode[]> {
    if (visitedResources.has(resourceUriKey(uri))) {
      return [createAlreadyShownNode(uri)];
    }

    const nextVisitedResources = new Set(visitedResources);
    nextVisitedResources.add(resourceUriKey(uri));
    const document = await this.tryLoadJsonDocument(uri, documentOverride);
    const nodes = [
      await this.createOutgoingReferencesGroup(nextVisitedResources, document),
      this.createIncomingReferencesGroup(uri, nextVisitedResources)
    ];

    if (document && isModelDocumentPath(uri.fsPath)) {
      nodes.push(this.createModelInheritanceGroup(uri, document));
    }

    return nodes;
  }

  private async createOutgoingReferencesGroup(
    visitedResources: Set<string>,
    document: ResourceGraphDocument | null
  ): Promise<ResourceGraphNode> {
    const references = document ? this.graphIndex.getReferences(document) : [];
    const referenceNodes = this.createOutgoingReferenceNodes(references, visitedResources);

    return new ResourceGraphNode(
      vscode.l10n.t("References"),
      referenceNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      {
        description: referenceNodes.length.toString(),
        children: referenceNodes.length > 0 ? referenceNodes : [createEmptyNode(vscode.l10n.t("No references"))],
        iconPath: new vscode.ThemeIcon("arrow-right")
      }
    );
  }

  private createOutgoingReferenceNodes(
    references: ResolvedResourceReference[],
    visitedResources: Set<string>
  ): ResourceGraphNode[] {
    return references.map(resolvedReference => {
      const reference = resolvedReference.reference;
      if (reference.value.startsWith("#")) {
        return new ResourceGraphNode(
          getReferenceLabel(reference),
          vscode.TreeItemCollapsibleState.None,
          { description: vscode.l10n.t("texture variable"), iconPath: new vscode.ThemeIcon("symbol-variable") }
        );
      }

      if (!resolvedReference.targetUri) {
        return new ResourceGraphNode(
          getReferenceLabel(reference),
          vscode.TreeItemCollapsibleState.None,
          { description: vscode.l10n.t("missing"), iconPath: new vscode.ThemeIcon("warning") }
        );
      }

      return this.createResourceNode(resolvedReference.targetUri, visitedResources, {
        label: getReferenceLabel(reference),
        description: getResourcePathLabel(resolvedReference.targetUri),
        iconPath: getReferenceIcon(reference)
      });
    });
  }

  private createIncomingReferencesGroup(uri: vscode.Uri, visitedResources: Set<string>): ResourceGraphNode {
    return new ResourceGraphNode(
      vscode.l10n.t("Referenced By"),
      vscode.TreeItemCollapsibleState.Collapsed,
      {
        children: async () => this.createIncomingReferenceNodes(uri, visitedResources),
        iconPath: new vscode.ThemeIcon("arrow-left")
      }
    );
  }

  private async createIncomingReferenceNodes(
    uri: vscode.Uri,
    visitedResources: Set<string>
  ): Promise<ResourceGraphNode[]> {
    const incomingReferences = await this.graphIndex.getIncomingReferences(uri);
    const groupedReferences = groupReferencesBySource(incomingReferences);

    if (groupedReferences.length === 0) {
      return [createEmptyNode(vscode.l10n.t("No incoming references"))];
    }

    const nodes = groupedReferences.map(group => this.createResourceNode(group.sourceUri, visitedResources, {
      description: group.references.length === 1
        ? getReferenceLabel(group.references[0].reference)
        : vscode.l10n.t("{0} references", group.references.length),
      iconPath: getResourceIcon(group.sourceUri.fsPath)
    }));
    nodes.sort(compareNodes);

    return nodes;
  }

  private createModelInheritanceGroup(
    uri: vscode.Uri,
    document: ResourceGraphDocument
  ): ResourceGraphNode {
    return new ResourceGraphNode(
      vscode.l10n.t("Model Inheritance"),
      vscode.TreeItemCollapsibleState.Collapsed,
      {
        children: () => this.createModelInheritanceNodes(uri, document),
        iconPath: new vscode.ThemeIcon("type-hierarchy")
      }
    );
  }

  private async createModelInheritanceNodes(
    uri: vscode.Uri,
    document: ResourceGraphDocument
  ): Promise<ResourceGraphNode[]> {
    const visitedModels = new Set<string>([resourceUriKey(uri)]);
    const parentNodes = await this.createParentModelNodes(document, visitedModels);
    const childNodes = await this.createChildModelNodes(uri, visitedModels);

    return [
      new ResourceGraphNode(
        vscode.l10n.t("Parent Models"),
        parentNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        {
          description: parentNodes.length.toString(),
          children: parentNodes.length > 0 ? parentNodes : [createEmptyNode(vscode.l10n.t("No parent model"))],
          iconPath: new vscode.ThemeIcon("arrow-up")
        }
      ),
      new ResourceGraphNode(
        vscode.l10n.t("Child Models"),
        childNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        {
          description: childNodes.length.toString(),
          children: childNodes.length > 0 ? childNodes : [createEmptyNode(vscode.l10n.t("No child models"))],
          iconPath: new vscode.ThemeIcon("arrow-down")
        }
      )
    ];
  }

  private async createParentModelNodes(
    document: ResourceGraphDocument,
    visitedModels: Set<string>
  ): Promise<ResourceGraphNode[]> {
    const parentReferences = this.graphIndex.getReferences(document)
      .filter(reference => reference.reference.relationship === "modelParent");

    const nodes = parentReferences.map(parentReference => {
      if (!parentReference.targetUri) {
        return new ResourceGraphNode(
          getReferenceLabel(parentReference.reference),
          vscode.TreeItemCollapsibleState.None,
          { description: vscode.l10n.t("missing"), iconPath: new vscode.ThemeIcon("warning") }
        );
      }

      return this.createParentModelNode(parentReference.targetUri, parentReference.reference, visitedModels);
    });
    nodes.sort(compareNodes);

    return nodes;
  }

  private createParentModelNode(
    uri: vscode.Uri,
    reference: ResourceReference,
    visitedModels: Set<string>
  ): ResourceGraphNode {
    const alreadyVisited = visitedModels.has(resourceUriKey(uri));

    return new ResourceGraphNode(
      getReferenceLabel(reference),
      alreadyVisited ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
      {
        description: alreadyVisited ? vscode.l10n.t("already shown") : getResourcePathLabel(uri),
        uri,
        children: async () => {
          if (alreadyVisited) {
            return [createAlreadyShownNode(uri)];
          }

          const document = await this.tryLoadJsonDocument(uri);
          if (!document) {
            return [];
          }

          const nextVisitedModels = new Set(visitedModels);
          nextVisitedModels.add(resourceUriKey(uri));
          return this.createParentModelNodes(document, nextVisitedModels);
        },
        iconPath: new vscode.ThemeIcon("file-code")
      }
    );
  }

  private async createChildModelNodes(
    uri: vscode.Uri,
    visitedModels: Set<string>
  ): Promise<ResourceGraphNode[]> {
    const childReferences = await this.graphIndex.getChildModelReferences(uri);
    const groupedReferences = groupReferencesBySource(childReferences);
    const nodes = groupedReferences.map(group =>
      this.createChildModelNode(group.sourceUri, group.references, visitedModels)
    );
    nodes.sort(compareNodes);

    return nodes;
  }

  private createChildModelNode(
    uri: vscode.Uri,
    references: ResolvedResourceReference[],
    visitedModels: Set<string>
  ): ResourceGraphNode {
    const alreadyVisited = visitedModels.has(resourceUriKey(uri));

    return new ResourceGraphNode(
      getResourcePathLabel(uri),
      alreadyVisited ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
      {
        description: alreadyVisited
          ? vscode.l10n.t("already shown")
          : references.length === 1
            ? getReferenceLabel(references[0].reference)
            : vscode.l10n.t("{0} references", references.length),
        uri,
        children: async () => {
          if (alreadyVisited) {
            return [createAlreadyShownNode(uri)];
          }

          const nextVisitedModels = new Set(visitedModels);
          nextVisitedModels.add(resourceUriKey(uri));
          return this.createChildModelNodes(uri, nextVisitedModels);
        },
        iconPath: new vscode.ThemeIcon("file-code")
      }
    );
  }

  private async tryLoadJsonDocument(
    uri: vscode.Uri,
    documentOverride?: ResourceGraphDocument
  ): Promise<ResourceGraphDocument | null> {
    if (documentOverride && resourceUriKey(documentOverride.uri) === resourceUriKey(uri)) {
      return documentOverride;
    }

    if (!uri.fsPath.toLowerCase().endsWith(".json")) {
      return null;
    }

    try {
      return await loadResourceGraphDocument(uri);
    } catch {
      return null;
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

function getReferenceLabel(reference: ResourceReference): string {
  if (reference.kind === "model") {
    return vscode.l10n.t("model: {0}", reference.value);
  }

  if (reference.kind === "texture") {
    return vscode.l10n.t("texture: {0}", reference.value);
  }

  if (reference.kind === "textureDirectory") {
    return vscode.l10n.t("texture directory: {0}", reference.value);
  }

  if (reference.kind === "font") {
    return vscode.l10n.t("font: {0}", reference.value);
  }

  if (reference.kind === "fontFile") {
    return vscode.l10n.t("font file: {0}", reference.value);
  }

  if (reference.kind === "shader") {
    return vscode.l10n.t("shader: {0}", reference.value);
  }

  return vscode.l10n.t("sound: {0}", reference.value);
}

function getReferenceIcon(reference: ResourceReference): vscode.ThemeIcon {
  if (reference.kind === "textureDirectory") {
    return new vscode.ThemeIcon("folder");
  }

  if (reference.kind === "model" || reference.kind === "shader" || reference.kind === "font" || reference.kind === "fontFile") {
    return new vscode.ThemeIcon("file-code");
  }

  return new vscode.ThemeIcon("file-media");
}

function getResourceIcon(fileName: string): vscode.ThemeIcon {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".json") {
    return isModelDocumentPath(fileName) ? new vscode.ThemeIcon("file-code") : new vscode.ThemeIcon("json");
  }

  if (extension === ".png" || extension === ".ogg") {
    return new vscode.ThemeIcon("file-media");
  }

  if (extension === ".vsh" || extension === ".fsh" || extension === ".glsl") {
    return new vscode.ThemeIcon("file-code");
  }

  return extension ? new vscode.ThemeIcon("file") : new vscode.ThemeIcon("folder");
}

function getResourcePathLabel(uri: vscode.Uri): string {
  const normalizedPath = path.normalize(uri.fsPath);
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");

  if (assetsIndex >= 0 && segments.length > assetsIndex + 2) {
    const namespace = segments[assetsIndex + 1];
    const resourcePath = segments.slice(assetsIndex + 2).join("/");
    return `${namespace}:${resourcePath}`;
  }

  return path.basename(uri.fsPath);
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}

function groupReferencesBySource(references: ResolvedResourceReference[]): Array<{
  sourceUri: vscode.Uri;
  references: ResolvedResourceReference[];
}> {
  const groups = new Map<string, { sourceUri: vscode.Uri; references: ResolvedResourceReference[] }>();

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

function createEmptyNode(label: string): ResourceGraphNode {
  return new ResourceGraphNode(
    label,
    vscode.TreeItemCollapsibleState.None,
    { iconPath: new vscode.ThemeIcon("circle-slash") }
  );
}

function createAlreadyShownNode(uri: vscode.Uri): ResourceGraphNode {
  return new ResourceGraphNode(
    getResourcePathLabel(uri),
    vscode.TreeItemCollapsibleState.None,
    {
      description: vscode.l10n.t("already shown"),
      uri,
      iconPath: getResourceIcon(uri.fsPath)
    }
  );
}

function compareNodes(left: ResourceGraphNode, right: ResourceGraphNode): number {
  return String(left.label ?? "").localeCompare(String(right.label ?? ""));
}

function toChildrenProvider(children: ResourceGraphChildren | undefined): () => Promise<ResourceGraphNode[]> {
  if (typeof children === "function") {
    return children;
  }

  return () => Promise.resolve(children ?? []);
}
