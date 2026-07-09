import * as vscode from "vscode";
import {
  createResourceReferencePathResolver,
  generateReferenceRedirectPath,
  type ResourceReferencePathResolver
} from "./pathGenerator";
import {
  collectModelDocumentUris,
  collectResourceReferenceUris,
  collectWorkspaceBlockstateUris
} from "./resourceGraphScan";
import {
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  resourceUriKey
} from "./resourceGraphSearch";
import {
  getResourceReferences,
  isResourceReferenceFileName,
  ResourceReference,
  ResourceReferenceDocument
} from "./resourceReferences";

export {
  type AssetResource,
  getAssetResource,
  isModelDocumentPath,
  isResourceGraphDocumentPath,
  isResourceJsonDocumentPath,
  resourceUriKey
} from "./resourceGraphSearch";

export interface ResourceGraphDocument extends ResourceReferenceDocument {
  uri: vscode.Uri;
}

export interface ResolvedResourceReference {
  reference: ResourceReference;
  sourceUri: vscode.Uri;
  targetUri: vscode.Uri | null;
}

export interface ResourceReferenceSourceGroup {
  sourceUri: vscode.Uri;
  references: ResolvedResourceReference[];
}

interface ResolvedReferencesCacheEntry {
  readonly version: number | undefined;
  readonly references: ResolvedResourceReference[];
}

export class ResourceGraphWorkspaceCache {
  private resourceReferenceUris: Promise<vscode.Uri[]> | null = null;
  private modelDocumentUris: Promise<vscode.Uri[]> | null = null;
  private blockstateUris: Promise<vscode.Uri[]> | null = null;

  invalidate(): void {
    this.resourceReferenceUris = null;
    this.modelDocumentUris = null;
    this.blockstateUris = null;
  }

  getResourceReferenceUris(): Promise<vscode.Uri[]> {
    if (!this.resourceReferenceUris) {
      this.resourceReferenceUris = collectResourceReferenceUris().catch(error => {
        this.resourceReferenceUris = null;
        throw error;
      });
    }

    return this.resourceReferenceUris;
  }

  getModelDocumentUris(): Promise<vscode.Uri[]> {
    if (!this.modelDocumentUris) {
      this.modelDocumentUris = collectModelDocumentUris().catch(error => {
        this.modelDocumentUris = null;
        throw error;
      });
    }

    return this.modelDocumentUris;
  }

  getBlockstateUris(): Promise<vscode.Uri[]> {
    if (!this.blockstateUris) {
      this.blockstateUris = collectWorkspaceBlockstateUris().catch(error => {
        this.blockstateUris = null;
        throw error;
      });
    }

    return this.blockstateUris;
  }
}

export class ResourceGraphIndex {
  private incomingReferencesByTarget: Promise<ReadonlyMap<string, ResolvedResourceReference[]>> | null = null;
  private readonly referencesByDocument = new Map<string, ResolvedReferencesCacheEntry>();
  private resourcePathResolver: ResourceReferencePathResolver | null = null;
  private childModelReferencesByParent: Promise<ReadonlyMap<string, ResolvedResourceReference[]>> | null = null;

  constructor(private readonly workspaceCache: ResourceGraphWorkspaceCache = new ResourceGraphWorkspaceCache()) { }

  invalidate(): void {
    this.workspaceCache.invalidate();
    this.incomingReferencesByTarget = null;
    this.referencesByDocument.clear();
    this.resourcePathResolver = null;
    this.childModelReferencesByParent = null;
  }

  getReferences(document: ResourceGraphDocument): ResolvedResourceReference[] {
    const key = resourceUriKey(document.uri);
    const version = getDocumentVersion(document);
    const cachedReferences = this.referencesByDocument.get(key);
    if (cachedReferences && cachedReferences.version === version) {
      return cachedReferences.references;
    }

    const references = uniqueResolvedReferences(resolveDocumentReferences(document, this.getResourcePathResolver()));
    this.referencesByDocument.set(key, { version, references });
    return references;
  }

  async getIncomingReferences(targetUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    const referencesByTarget = await this.getIncomingReferencesByTarget();
    return referencesByTarget.get(resourceUriKey(targetUri)) ?? [];
  }

  private getIncomingReferencesByTarget(): Promise<ReadonlyMap<string, ResolvedResourceReference[]>> {
    if (this.incomingReferencesByTarget) {
      return this.incomingReferencesByTarget;
    }

    this.incomingReferencesByTarget = this.collectIncomingReferencesByTarget().catch(error => {
      this.incomingReferencesByTarget = null;
      throw error;
    });
    return this.incomingReferencesByTarget;
  }

  async getChildModelReferences(modelUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    const referencesByParent = await this.getChildModelReferencesByParent();

    return referencesByParent.get(resourceUriKey(modelUri)) ?? [];
  }

  private getChildModelReferencesByParent(): Promise<ReadonlyMap<string, ResolvedResourceReference[]>> {
    if (this.childModelReferencesByParent) {
      return this.childModelReferencesByParent;
    }

    this.childModelReferencesByParent = this.collectChildModelReferencesByParent().catch(error => {
      this.childModelReferencesByParent = null;
      throw error;
    });
    return this.childModelReferencesByParent;
  }

  private async collectChildModelReferencesByParent(): Promise<ReadonlyMap<string, ResolvedResourceReference[]>> {
    const documents = await collectModelDocuments(this.workspaceCache);
    const references = uniqueResolvedReferences(documents.flatMap(document =>
      this.getReferences(document)
        .filter(reference => reference.reference.relationship === "modelParent" && reference.targetUri !== null)
    ));
    const referencesByParent = new Map<string, ResolvedResourceReference[]>();

    for (const reference of references) {
      if (!reference.targetUri) {
        continue;
      }

      const targetKey = resourceUriKey(reference.targetUri);
      const targetReferences = referencesByParent.get(targetKey);
      if (targetReferences) {
        targetReferences.push(reference);
      } else {
        referencesByParent.set(targetKey, [reference]);
      }
    }

    return referencesByParent;
  }

  private async collectIncomingReferencesByTarget(): Promise<ReadonlyMap<string, ResolvedResourceReference[]>> {
    const documents = await collectResourceDocuments(this.workspaceCache);
    const references = uniqueResolvedReferences(documents.flatMap(document =>
      this.getReferences(document).filter(reference => reference.targetUri !== null)
    ));
    const referencesByTarget = new Map<string, ResolvedResourceReference[]>();

    for (const reference of references) {
      if (!reference.targetUri) {
        continue;
      }

      const targetKey = resourceUriKey(reference.targetUri);
      const targetReferences = referencesByTarget.get(targetKey);
      if (targetReferences) {
        targetReferences.push(reference);
      } else {
        referencesByTarget.set(targetKey, [reference]);
      }
    }

    return referencesByTarget;
  }

  private getResourcePathResolver(): ResourceReferencePathResolver {
    if (!this.resourcePathResolver) {
      this.resourcePathResolver = createResourceReferencePathResolver();
    }

    return this.resourcePathResolver;
  }
}

export async function loadResourceGraphDocument(uri: vscode.Uri): Promise<ResourceGraphDocument> {
  const openDocument = vscode.workspace.textDocuments.find(document =>
    isResourceGraphDocumentPath(document.fileName) && resourceUriKey(document.uri) === resourceUriKey(uri)
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

export function groupReferencesBySource(references: ResolvedResourceReference[]): ResourceReferenceSourceGroup[] {
  const groups = new Map<string, ResourceReferenceSourceGroup>();

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

  const fileUris = (await workspaceCache.getResourceReferenceUris()).filter(uri => !documentsByKey.has(resourceUriKey(uri)));
  const fileDocuments = await mapLimit(fileUris, 24, async uri => {
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

async function collectModelDocuments(workspaceCache: ResourceGraphWorkspaceCache): Promise<ResourceGraphDocument[]> {
  const documentsByKey = new Map<string, ResourceGraphDocument>();

  for (const document of vscode.workspace.textDocuments) {
    if (isModelDocumentPath(document.fileName)) {
      documentsByKey.set(resourceUriKey(document.uri), document);
    }
  }

  const fileUris = (await workspaceCache.getModelDocumentUris()).filter(uri => !documentsByKey.has(resourceUriKey(uri)));
  const fileDocuments = await mapLimit(fileUris, 24, async uri => {
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

function uniqueResolvedReferences(references: ResolvedResourceReference[]): ResolvedResourceReference[] {
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
  const version = (document as { version?: unknown }).version;
  return typeof version === "number" ? version : undefined;
}

async function mapLimit<T, U>(values: T[], limit: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}
