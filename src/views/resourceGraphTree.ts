import * as path from "node:path";
import * as vscode from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { getResourceReferences, ResourceReference } from "../utils/resourceReferences";

interface ResourceDocument {
  languageId: string;
  fileName: string;
  getText(): string;
}

class ResourceGraphNode extends vscode.TreeItem {
  public readonly children: ResourceGraphNode[];

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options: {
      description?: string;
      uri?: vscode.Uri;
      children?: ResourceGraphNode[];
      iconPath?: vscode.ThemeIcon;
      contextValue?: string;
    } = {}
  ) {
    super(label, collapsibleState);
    this.description = options.description;
    this.resourceUri = options.uri;
    this.children = options.children ?? [];
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
      return element.children;
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

    const children = await this.createReferenceNodes(document, getResourceReferences(document));
    return new ResourceGraphNode(
      vscode.l10n.t("Current File"),
      vscode.TreeItemCollapsibleState.Expanded,
      {
        description: path.basename(document.fileName),
        uri: document.uri,
        children,
        iconPath: new vscode.ThemeIcon("json")
      }
    );
  }

  private async createBlocksNode(): Promise<ResourceGraphNode> {
    const blockstateUris = await vscode.workspace.findFiles("**/assets/*/blockstates/*.json", "**/node_modules/**", 300);
    const blockNodes: ResourceGraphNode[] = [];

    for (const uri of blockstateUris) {
      blockNodes.push(await this.createBlockNode(uri));
    }

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

  private async createBlockNode(uri: vscode.Uri): Promise<ResourceGraphNode> {
    const document = await readJsonDocument(uri);
    const modelReferences = getResourceReferences(document).filter(reference => reference.kind === "model");
    const modelNodes: ResourceGraphNode[] = [];

    for (const reference of modelReferences) {
      const modelNode = await this.createModelNode(document, reference);
      if (modelNode) {
        modelNodes.push(modelNode);
      }
    }

    const blockstateNode = new ResourceGraphNode(
      vscode.l10n.t("blockstate"),
      vscode.TreeItemCollapsibleState.None,
      { uri, iconPath: new vscode.ThemeIcon("json") }
    );

    return new ResourceGraphNode(
      path.basename(uri.fsPath, ".json"),
      modelNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      {
        uri,
        children: [blockstateNode, ...modelNodes],
        iconPath: new vscode.ThemeIcon("symbol-structure")
      }
    );
  }

  private async createModelNode(document: ResourceDocument, reference: ResourceReference): Promise<ResourceGraphNode | null> {
    const modelUri = generateRedirectPath(reference.value, document as vscode.TextDocument, reference.target, reference.source, reference.extension);
    if (!modelUri) {
      return new ResourceGraphNode(
        vscode.l10n.t("model: {0}", reference.value),
        vscode.TreeItemCollapsibleState.None,
        { description: vscode.l10n.t("missing"), iconPath: new vscode.ThemeIcon("warning") }
      );
    }

    const modelDocument = await readJsonDocument(modelUri);
    const textureNodes = await this.createReferenceNodes(
      modelDocument,
      getResourceReferences(modelDocument).filter(modelReference => modelReference.kind === "texture")
    );

    return new ResourceGraphNode(
      vscode.l10n.t("model: {0}", reference.value),
      textureNodes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      {
        uri: modelUri,
        children: textureNodes,
        iconPath: new vscode.ThemeIcon("file-code")
      }
    );
  }

  private async createReferenceNodes(document: ResourceDocument, references: ResourceReference[]): Promise<ResourceGraphNode[]> {
    const nodes: ResourceGraphNode[] = [];

    for (const reference of references) {
      if (reference.value.startsWith("#")) {
        nodes.push(new ResourceGraphNode(
          `${reference.kind}: ${reference.value}`,
          vscode.TreeItemCollapsibleState.None,
          { description: vscode.l10n.t("texture variable"), iconPath: new vscode.ThemeIcon("symbol-variable") }
        ));
        continue;
      }

      const uri = generateRedirectPath(reference.value, document as vscode.TextDocument, reference.target, reference.source, reference.extension);
      nodes.push(new ResourceGraphNode(
        `${reference.kind}: ${reference.value}`,
        vscode.TreeItemCollapsibleState.None,
        {
          description: uri ? undefined : vscode.l10n.t("missing"),
          uri: uri ?? undefined,
          iconPath: uri ? new vscode.ThemeIcon(reference.kind === "model" ? "file-code" : "file-media") : new vscode.ThemeIcon("warning")
        }
      ));
    }

    return nodes;
  }
}

async function readJsonDocument(uri: vscode.Uri): Promise<ResourceDocument> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    languageId: "json",
    fileName: uri.fsPath,
    getText: () => Buffer.from(bytes).toString("utf8")
  };
}
