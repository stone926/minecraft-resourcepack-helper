import * as path from "node:path";
import * as vscode from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { getResourceReferences, ResourceReference } from "../utils/resourceReferences";

interface ResourceDocument {
  languageId: string;
  fileName: string;
  getText(): string;
}

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
    } = {}
  ) {
    super(label, collapsibleState);
    this.description = options.description;
    this.resourceUri = options.uri;
    this.childrenProvider = toChildrenProvider(options.children);
    this.iconPath = options.iconPath;
    this.contextValue = options.contextValue;

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
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ResourceGraphNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ResourceGraphNode): Promise<ResourceGraphNode[]> {
    if (element) {
      return element.getChildren();
    }

    return [
      await this.createCurrentFileNode(),
      await this.createBlocksNode()
    ];
  }

  private async createCurrentFileNode(): Promise<ResourceGraphNode> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "json") {
      return new ResourceGraphNode(
        vscode.l10n.t("Current File"),
        vscode.TreeItemCollapsibleState.None,
        { description: vscode.l10n.t("No JSON editor"), iconPath: new vscode.ThemeIcon("json") }
      );
    }

    const children = isBlockstateDocument(document.fileName)
      ? await this.createBlockstateModelNodes(document)
      : await this.createReferenceNodes(document, getResourceReferences(document));

    return new ResourceGraphNode(
      vscode.l10n.t("Current File"),
      children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      {
        description: path.basename(document.fileName),
        uri: document.uri,
        children,
        iconPath: new vscode.ThemeIcon("json")
      }
    );
  }

  private async createBlocksNode(): Promise<ResourceGraphNode> {
    const blockstateUris = await vscode.workspace.findFiles("**/assets/*/blockstates/*.json", "**/node_modules/**");
    const blockNodes = blockstateUris.map(uri => this.createBlockNode(uri));
    blockNodes.sort((left, right) => left.label?.toString().localeCompare(right.label?.toString() ?? "") ?? 0);

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

  private createBlockNode(uri: vscode.Uri): ResourceGraphNode {
    return new ResourceGraphNode(
      path.basename(uri.fsPath, ".json"),
      vscode.TreeItemCollapsibleState.Collapsed,
      {
        uri,
        children: () => this.createBlockChildren(uri),
        iconPath: new vscode.ThemeIcon("symbol-structure")
      }
    );
  }

  private async createBlockChildren(uri: vscode.Uri): Promise<ResourceGraphNode[]> {
    const document = await readJsonDocument(uri);
    const modelNodes = await this.createBlockstateModelNodes(document);
    return [
      new ResourceGraphNode(
        vscode.l10n.t("blockstate"),
        vscode.TreeItemCollapsibleState.None,
        { uri, iconPath: new vscode.ThemeIcon("json") }
      ),
      ...modelNodes
    ];
  }

  private async createBlockstateModelNodes(document: ResourceDocument): Promise<ResourceGraphNode[]> {
    const modelReferences = uniqueResourceReferences(getResourceReferences(document).filter(reference => reference.kind === "model"));
    const modelNodes: ResourceGraphNode[] = [];

    for (const reference of modelReferences) {
      const modelNode = await this.createModelNode(document, reference, new Set<string>());
      if (modelNode) {
        modelNodes.push(modelNode);
      }
    }

    return modelNodes;
  }

  private async createModelNode(
    document: ResourceDocument,
    reference: ResourceReference,
    visitedModels: Set<string>
  ): Promise<ResourceGraphNode | null> {
    const modelUri = generateRedirectPath(reference.value, document as vscode.TextDocument, reference.target, reference.source, reference.extension);
    if (!modelUri) {
      return new ResourceGraphNode(
        vscode.l10n.t("model: {0}", reference.value),
        vscode.TreeItemCollapsibleState.None,
        { description: vscode.l10n.t("missing"), iconPath: new vscode.ThemeIcon("warning") }
      );
    }

    if (visitedModels.has(modelUri.fsPath)) {
      return new ResourceGraphNode(
        vscode.l10n.t("model: {0}", reference.value),
        vscode.TreeItemCollapsibleState.None,
        { description: vscode.l10n.t("already shown"), uri: modelUri, iconPath: new vscode.ThemeIcon("file-code") }
      );
    }

    visitedModels.add(modelUri.fsPath);

    const modelDocument = await readJsonDocument(modelUri);
    const modelReferences = getResourceReferences(modelDocument);
    const parentModelNodes: ResourceGraphNode[] = [];

    for (const parentReference of uniqueResourceReferences(modelReferences.filter(modelReference => modelReference.kind === "model"))) {
      const parentNode = await this.createModelNode(modelDocument, parentReference, new Set(visitedModels));
      if (parentNode) {
        parentModelNodes.push(parentNode);
      }
    }

    const resourceNodes = await this.createReferenceNodes(
      modelDocument,
      uniqueResourceReferences(modelReferences.filter(modelReference => modelReference.kind !== "model"))
    );
    const children = [...parentModelNodes, ...resourceNodes];

    return new ResourceGraphNode(
      vscode.l10n.t("model: {0}", reference.value),
      children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      {
        uri: modelUri,
        children,
        iconPath: new vscode.ThemeIcon("file-code")
      }
    );
  }

  private async createReferenceNodes(document: ResourceDocument, references: ResourceReference[]): Promise<ResourceGraphNode[]> {
    const nodes: ResourceGraphNode[] = [];

    for (const reference of references) {
      if (reference.value.startsWith("#")) {
        nodes.push(new ResourceGraphNode(
          getReferenceLabel(reference),
          vscode.TreeItemCollapsibleState.None,
          { description: vscode.l10n.t("texture variable"), iconPath: new vscode.ThemeIcon("symbol-variable") }
        ));
        continue;
      }

      const uri = generateRedirectPath(reference.value, document as vscode.TextDocument, reference.target, reference.source, reference.extension);
      nodes.push(new ResourceGraphNode(
        getReferenceLabel(reference),
        vscode.TreeItemCollapsibleState.None,
        {
          description: uri ? undefined : vscode.l10n.t("missing"),
          uri: uri ?? undefined,
          iconPath: uri ? getReferenceIcon(reference) : new vscode.ThemeIcon("warning")
        }
      ));
    }

    return nodes;
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

  if (reference.kind === "shader") {
    return vscode.l10n.t("shader: {0}", reference.value);
  }

  return vscode.l10n.t("sound: {0}", reference.value);
}

function getReferenceIcon(reference: ResourceReference): vscode.ThemeIcon {
  if (reference.kind === "model" || reference.kind === "shader" || reference.kind === "font") {
    return new vscode.ThemeIcon("file-code");
  }

  return new vscode.ThemeIcon("file-media");
}

function toChildrenProvider(children: ResourceGraphChildren | undefined): () => Promise<ResourceGraphNode[]> {
  if (typeof children === "function") {
    return children;
  }

  return () => Promise.resolve(children ?? []);
}

async function readJsonDocument(uri: vscode.Uri): Promise<ResourceDocument> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    languageId: "json",
    fileName: uri.fsPath,
    getText: () => Buffer.from(bytes).toString("utf8")
  };
}

function isBlockstateDocument(fileName: string): boolean {
  return /[\\/]blockstates[\\/].+\.json$/i.test(fileName);
}

function uniqueResourceReferences(references: ResourceReference[]): ResourceReference[] {
  const uniqueReferences = new Map<string, ResourceReference>();

  for (const reference of references) {
    const key = `${reference.kind}\0${reference.target}\0${reference.source}\0${reference.extension ?? ""}\0${reference.value}`;
    if (!uniqueReferences.has(key)) {
      uniqueReferences.set(key, reference);
    }
  }

  return [...uniqueReferences.values()];
}
