import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createResourcePathResolver, generateRedirectPath, type ResourcePathResolver } from "./pathGenerator";
import { getResourceReferences, ResourceReference, ResourceReferenceDocument } from "./resourceReferences";

export interface ResourceGraphDocument extends ResourceReferenceDocument {
  uri: vscode.Uri;
}

export interface ResolvedResourceReference {
  reference: ResourceReference;
  sourceUri: vscode.Uri;
  targetUri: vscode.Uri | null;
}

export class ResourceGraphIndex {
  private references: ResolvedResourceReference[] | null = null;

  invalidate(): void {
    this.references = null;
  }

  getReferences(document: ResourceGraphDocument): ResolvedResourceReference[] {
    return uniqueResolvedReferences(resolveDocumentReferences(document, createResourcePathResolver()));
  }

  async getIncomingReferences(targetUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    const targetKey = resourceUriKey(targetUri);
    const references = await this.getAllReferences();

    return references.filter(reference =>
      reference.targetUri !== null && resourceUriKey(reference.targetUri) === targetKey
    );
  }

  async getChildModelReferences(modelUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    const incomingReferences = await this.getIncomingReferences(modelUri);

    return incomingReferences.filter(reference =>
      reference.reference.relationship === "modelParent" && isModelDocumentPath(reference.sourceUri.fsPath)
    );
  }

  private async getAllReferences(): Promise<ResolvedResourceReference[]> {
    if (this.references) {
      return this.references;
    }

    const documents = await collectResourceDocuments();
    const resolveResourcePath = createResourcePathResolver();
    const references = documents.flatMap(document => resolveDocumentReferences(document, resolveResourcePath));
    this.references = uniqueResolvedReferences(references);

    return this.references;
  }
}

export async function loadResourceGraphDocument(uri: vscode.Uri): Promise<ResourceGraphDocument> {
  const openDocument = vscode.workspace.textDocuments.find(document =>
    document.languageId === "json" && resourceUriKey(document.uri) === resourceUriKey(uri)
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

export function isModelDocumentPath(fileName: string): boolean {
  return /[\\/]models[\\/](?:block|item)[\\/].+\.json$/i.test(fileName);
}

export function resourceUriKey(uri: vscode.Uri): string {
  const key = uri.scheme === "file" ? path.normalize(uri.fsPath) : uri.toString();
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function resolveDocumentReferences(
  document: ResourceGraphDocument,
  resolveResourcePath: ResourcePathResolver = generateRedirectPath
): ResolvedResourceReference[] {
  return getResourceReferences(document).map(reference => ({
    reference,
    sourceUri: document.uri,
    targetUri: reference.value.startsWith("#")
      ? null
      : resolveResourcePath(reference.value, document, reference.target, reference.source, reference.extension)
  }));
}

async function collectResourceDocuments(): Promise<ResourceGraphDocument[]> {
  const documentsByKey = new Map<string, ResourceGraphDocument>();

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "json" && isResourceJsonDocumentPath(document.fileName)) {
      documentsByKey.set(resourceUriKey(document.uri), document);
    }
  }

  const fileUris = (await collectResourceJsonUris()).filter(uri => !documentsByKey.has(resourceUriKey(uri)));
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

async function collectResourceJsonUris(): Promise<vscode.Uri[]> {
  const urisByKey = new Map<string, vscode.Uri>();
  const workspaceUris = await vscode.workspace.findFiles("**/assets/**/*.json", "**/node_modules/**");

  for (const uri of workspaceUris) {
    urisByKey.set(resourceUriKey(uri), uri);
  }

  const defaultAssetsPath = vscode.workspace.getConfiguration().get<string>("McResHelper.defaultMcAssetsPath");
  if (defaultAssetsPath) {
    for (const root of await getDefaultAssetsRoots(defaultAssetsPath)) {
      for (const uri of await collectJsonUris(root)) {
        urisByKey.set(resourceUriKey(uri), uri);
      }
    }
  }

  return [...urisByKey.values()];
}

async function getDefaultAssetsRoots(configuredPath: string): Promise<string[]> {
  const normalizedPath = path.normalize(configuredPath);
  const candidates = [
    path.basename(normalizedPath).toLowerCase() === "assets" ? normalizedPath : null,
    path.basename(path.dirname(normalizedPath)).toLowerCase() === "assets" ? path.dirname(normalizedPath) : null,
    path.join(normalizedPath, "assets")
  ].filter((candidate): candidate is string => candidate !== null);

  const roots: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        roots.push(candidate);
      }
    } catch {
      // Ignore invalid configuration paths here; diagnostics already surface unresolved references.
    }
  }

  return roots;
}

async function collectJsonUris(directory: string): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  await collectJsonUrisInto(directory, uris);
  return uris;
}

async function collectJsonUrisInto(directory: string, uris: vscode.Uri[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        await collectJsonUrisInto(entryPath, uris);
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      uris.push(vscode.Uri.file(entryPath));
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "out";
}

export function isResourceJsonDocumentPath(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/].+\.json$/i.test(fileName);
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
