import * as vscode from "vscode";
import { mapWithConcurrency } from "../utils/asyncWorkPool";
import {
  createResourceReferencePathResolver,
  generateReferenceRedirectPath,
  type ResourceReferencePathResolver
} from "../utils/pathGenerator";
import type {
  ResolvedResourceReference,
  ResourceGraphDocument,
  ResourceGraphPathChangeKind
} from "../utils/resourceGraph";
import { classifyResourceGraphPaths } from "../utils/resourceGraphScanCore";
import {
  isResourceGraphDocumentPath,
  resourceUriKey
} from "../utils/resourceGraphSearch";
import {
  getResourceReferences,
  isResourceReferenceFileName
} from "../utils/resourceReferences";
import { ResourceGraphReferenceIndex } from "../utils/resourceGraphReferenceIndex";
import {
  collectResourceGraphWorkspaceSnapshot,
  type ResourceGraphWorkspaceSnapshot
} from "./resourceGraphWorkspaceScan";

interface ResolvedReferencesCacheEntry {
  readonly version: number | undefined;
  readonly references: ResolvedResourceReference[];
}

export class ResourceGraphWorkspaceCache {
  private snapshot: Promise<ResourceGraphWorkspaceSnapshot> | null = null;

  invalidate(): void {
    this.snapshot = null;
  }

  updatePath(uri: vscode.Uri, kind: ResourceGraphPathChangeKind): void {
    if (!this.snapshot || kind === "change") {
      return;
    }

    const current = this.snapshot;
    const updated = current.then(snapshot => updateWorkspaceSnapshot(snapshot, uri, kind));
    this.snapshot = updated.catch(error => {
      if (this.snapshot === updated) {
        this.snapshot = null;
      }
      throw error;
    });
  }

  async getResourceReferenceUris(): Promise<vscode.Uri[]> {
    return (await this.getSnapshot()).resourceReferenceUris;
  }

  async getModelDocumentUris(): Promise<vscode.Uri[]> {
    return (await this.getSnapshot()).modelDocumentUris;
  }

  async getBlockstateUris(): Promise<vscode.Uri[]> {
    return (await this.getSnapshot()).blockstateUris;
  }

  private getSnapshot(): Promise<ResourceGraphWorkspaceSnapshot> {
    if (!this.snapshot) {
      this.snapshot = collectResourceGraphWorkspaceSnapshot().catch(error => {
        this.snapshot = null;
        throw error;
      });
    }
    return this.snapshot;
  }
}

export class ResourceGraphIndex {
  private readonly referencesByDocument = new Map<string, ResolvedReferencesCacheEntry>();
  private readonly pendingDocuments = new Map<string, ResourceGraphDocument | vscode.Uri>();
  private referenceIndex: ResourceGraphReferenceIndex<ResolvedResourceReference> | null = null;
  private indexBuild: Promise<void> | null = null;
  private indexGeneration = 0;
  private resourcePathResolver: ResourceReferencePathResolver | null = null;

  constructor(
    private readonly workspaceCache: ResourceGraphWorkspaceCache = new ResourceGraphWorkspaceCache()
  ) {}

  invalidate(): void {
    this.workspaceCache.invalidate();
    this.referencesByDocument.clear();
    this.pendingDocuments.clear();
    this.referenceIndex = null;
    this.indexBuild = null;
    this.indexGeneration++;
    this.resourcePathResolver = null;
  }

  invalidateDocument(document: ResourceGraphDocument): void {
    const key = resourceUriKey(document.uri);
    this.referencesByDocument.delete(key);
    this.pendingDocuments.set(key, document);
  }

  invalidatePath(uri: vscode.Uri, kind: ResourceGraphPathChangeKind = "change"): void {
    const key = resourceUriKey(uri);
    this.workspaceCache.updatePath(uri, kind);
    this.referencesByDocument.delete(key);
    this.pendingDocuments.set(key, uri);
  }

  getReferences(document: ResourceGraphDocument): ResolvedResourceReference[] {
    const key = resourceUriKey(document.uri);
    const version = getDocumentVersion(document);
    const cachedReferences = this.referencesByDocument.get(key);
    if (cachedReferences && cachedReferences.version === version) {
      return cachedReferences.references;
    }

    const references = uniqueResolvedReferences(
      resolveDocumentReferences(document, this.getResourcePathResolver())
    );
    this.referencesByDocument.set(key, { version, references });
    return references;
  }

  async getIncomingReferences(targetUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    await this.ensureReferenceIndexes();
    return [...(this.referenceIndex?.getIncoming(resourceUriKey(targetUri)) ?? [])];
  }

  async getChildModelReferences(modelUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    await this.ensureReferenceIndexes();
    return [...(this.referenceIndex?.getChildren(resourceUriKey(modelUri)) ?? [])];
  }

  private async ensureReferenceIndexes(): Promise<void> {
    if (!this.referenceIndex) {
      if (!this.indexBuild) {
        const generation = this.indexGeneration;
        const build = this.buildReferenceIndexes(generation).catch(error => {
          if (generation === this.indexGeneration) {
            this.referenceIndex = null;
          }
          throw error;
        }).finally(() => {
          if (this.indexBuild === build) {
            this.indexBuild = null;
          }
        });
        this.indexBuild = build;
      }
      await this.indexBuild;
      if (!this.referenceIndex) {
        return this.ensureReferenceIndexes();
      }
    }
    await this.applyPendingDocuments();
  }

  private async buildReferenceIndexes(generation: number): Promise<void> {
    const documents = await collectResourceDocuments(this.workspaceCache);
    const referenceIndex = new ResourceGraphReferenceIndex<ResolvedResourceReference>(reference => ({
      sourceKey: resourceUriKey(reference.sourceUri),
      targetKey: resourceUriKey(reference.targetUri!),
      modelParent: reference.reference.relationship === "modelParent"
    }));
    for (const document of documents) {
      const references = this.getReferences(document).filter(reference => reference.targetUri !== null);
      referenceIndex.replaceSource(resourceUriKey(document.uri), references);
    }
    if (generation === this.indexGeneration) {
      this.referenceIndex = referenceIndex;
    }
  }

  private async applyPendingDocuments(): Promise<void> {
    while (this.pendingDocuments.size > 0) {
      const pending = [...this.pendingDocuments.entries()];
      this.pendingDocuments.clear();
      for (const [key, value] of pending) {
        this.removeIndexedSource(key);
        const document = "getText" in value
          ? value
          : await tryLoadResourceGraphDocument(value);
        if (document) {
          this.indexDocument(document);
        }
      }
    }
  }

  private indexDocument(document: ResourceGraphDocument): void {
    const sourceKey = resourceUriKey(document.uri);
    this.removeIndexedSource(sourceKey);
    const references = this.getReferences(document).filter(reference => reference.targetUri !== null);
    this.referenceIndex?.replaceSource(sourceKey, references);
  }

  private removeIndexedSource(sourceKey: string): void {
    this.referenceIndex?.removeSource(sourceKey);
  }

  private getResourcePathResolver(): ResourceReferencePathResolver {
    if (!this.resourcePathResolver) {
      this.resourcePathResolver = createResourceReferencePathResolver();
    }
    return this.resourcePathResolver;
  }
}

function updateWorkspaceSnapshot(
  snapshot: ResourceGraphWorkspaceSnapshot,
  uri: vscode.Uri,
  kind: Exclude<ResourceGraphPathChangeKind, "change">
): ResourceGraphWorkspaceSnapshot {
  const classified = classifyResourceGraphPaths([uri.fsPath], { includeBlockstates: true });
  return {
    resourceReferenceUris: updateSnapshotUris(
      snapshot.resourceReferenceUris,
      uri,
      classified.resourceReferencePaths.length > 0,
      kind
    ),
    modelDocumentUris: updateSnapshotUris(
      snapshot.modelDocumentUris,
      uri,
      classified.modelDocumentPaths.length > 0,
      kind
    ),
    blockstateUris: updateSnapshotUris(
      snapshot.blockstateUris,
      uri,
      classified.blockstatePaths.length > 0,
      kind
    )
  };
}

function updateSnapshotUris(
  uris: readonly vscode.Uri[],
  changedUri: vscode.Uri,
  belongs: boolean,
  kind: Exclude<ResourceGraphPathChangeKind, "change">
): vscode.Uri[] {
  const changedKey = resourceUriKey(changedUri);
  const retained = uris.filter(uri => resourceUriKey(uri) !== changedKey);
  return kind === "create" && belongs ? [...retained, changedUri] : retained;
}

export async function loadResourceGraphDocument(uri: vscode.Uri): Promise<ResourceGraphDocument> {
  const openDocument = vscode.workspace.textDocuments.find(document =>
    isResourceGraphDocumentPath(document.fileName)
    && resourceUriKey(document.uri) === resourceUriKey(uri)
  );
  if (openDocument) {
    return openDocument;
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    uri,
    languageId: "json",
    fileName: uri.fsPath,
    getText: () => Buffer.from(bytes).toString("utf8")
  };
}

async function tryLoadResourceGraphDocument(
  uri: vscode.Uri
): Promise<ResourceGraphDocument | null> {
  if (!isResourceGraphDocumentPath(uri.fsPath)) {
    return null;
  }
  try {
    return await loadResourceGraphDocument(uri);
  } catch {
    return null;
  }
}

function resolveDocumentReferences(
  document: ResourceGraphDocument,
  resolveResourcePath: ResourceReferencePathResolver = generateReferenceRedirectPath
): ResolvedResourceReference[] {
  return getResourceReferences(document).map(reference => ({
    reference,
    sourceUri: document.uri,
    targetUri: reference.value.startsWith("#")
      ? null
      : resolveResourcePath(reference, document)
  }));
}

async function collectResourceDocuments(
  workspaceCache: ResourceGraphWorkspaceCache
): Promise<ResourceGraphDocument[]> {
  const documentsByKey = new Map<string, ResourceGraphDocument>();
  for (const document of vscode.workspace.textDocuments) {
    if (isResourceReferenceFileName(document.fileName)) {
      documentsByKey.set(resourceUriKey(document.uri), document);
    }
  }

  const fileUris = (await workspaceCache.getResourceReferenceUris())
    .filter(uri => !documentsByKey.has(resourceUriKey(uri)));
  const fileDocuments = await mapWithConcurrency(fileUris, 24, async uri => {
    try {
      return await loadResourceGraphDocument(uri);
    } catch {
      return null;
    }
  });
  for (const document of fileDocuments) {
    if (document) {
      documentsByKey.set(resourceUriKey(document.uri), document);
    }
  }
  return [...documentsByKey.values()];
}

function uniqueResolvedReferences(
  references: ResolvedResourceReference[]
): ResolvedResourceReference[] {
  const uniqueReferences = new Map<string, ResolvedResourceReference>();
  for (const reference of references) {
    const key = [
      resourceUriKey(reference.sourceUri),
      reference.targetUri ? resourceUriKey(reference.targetUri) : "",
      reference.reference.kind,
      reference.reference.relationship ?? "",
      reference.reference.target,
      reference.reference.source,
      reference.reference.extension ?? "",
      reference.reference.value
    ].join("\0");
    if (!uniqueReferences.has(key)) {
      uniqueReferences.set(key, reference);
    }
  }
  return [...uniqueReferences.values()];
}

function getDocumentVersion(document: ResourceGraphDocument): number | undefined {
  return typeof document.version === "number" ? document.version : undefined;
}
