import * as vscode from "vscode";
import {
  loadResourceGraphDocument,
  ResourceGraphIndex,
  ResourceGraphWorkspaceCache,
  type ResourceGraphDocument,
  type ResourceGraphPathChangeKind,
  type ResolvedResourceReference
} from "../utils/resourceGraph";
import type {
  ResourceGraphTreeDocument,
  ResourceGraphTreeModelHost,
  ResourceGraphTreeResolvedReference,
  ResourceGraphUriLike
} from "../views/resourceGraphTreeModel";

export class ResourceGraphService implements ResourceGraphTreeModelHost {
  private readonly workspaceQuery = new ResourceGraphWorkspaceCache();
  private readonly index = new ResourceGraphIndex(this.workspaceQuery);

  public invalidateAll(): void {
    this.index.invalidate();
  }

  public invalidateDocument(document: ResourceGraphTreeDocument): void {
    this.index.invalidateDocument(toGraphDocument(document));
  }

  public invalidatePath(uri: ResourceGraphUriLike, kind: ResourceGraphPathChangeKind = "change"): void {
    this.index.invalidatePath(toVscodeUri(uri), kind);
  }

  public getBlockstateUris(): Promise<readonly ResourceGraphUriLike[]> {
    return this.workspaceQuery.getBlockstateUris();
  }

  public getReferences(document: ResourceGraphTreeDocument): readonly ResourceGraphTreeResolvedReference[] {
    return this.index.getReferences(toGraphDocument(document));
  }

  public getIncomingReferences(uri: ResourceGraphUriLike): Promise<readonly ResolvedResourceReference[]> {
    return this.index.getIncomingReferences(toVscodeUri(uri));
  }

  public getChildModelReferences(uri: ResourceGraphUriLike): Promise<readonly ResolvedResourceReference[]> {
    return this.index.getChildModelReferences(toVscodeUri(uri));
  }

  public loadDocument(uri: ResourceGraphUriLike): Promise<ResourceGraphDocument> {
    return loadResourceGraphDocument(toVscodeUri(uri));
  }
}

function toGraphDocument(document: ResourceGraphTreeDocument): ResourceGraphDocument {
  return document.uri instanceof vscode.Uri
    ? document as ResourceGraphDocument
    : { ...document, uri: toVscodeUri(document.uri) };
}

function toVscodeUri(uri: ResourceGraphUriLike): vscode.Uri {
  return uri instanceof vscode.Uri ? uri : vscode.Uri.file(uri.fsPath);
}
