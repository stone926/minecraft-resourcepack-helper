import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createResourcePathResolver, generateRedirectPath, type ResourcePathResolver } from "./pathGenerator";
import {
  getResourceReferences,
  isResourceReferenceFileName,
  ResourceReference,
  ResourceReferenceDocument
} from "./resourceReferences";

export interface ResourceGraphDocument extends ResourceReferenceDocument {
  uri: vscode.Uri;
}

export interface ResolvedResourceReference {
  reference: ResourceReference;
  sourceUri: vscode.Uri;
  targetUri: vscode.Uri | null;
}

interface IncomingReferenceSearch {
  readonly values: Set<string>;
  matchesText(text: string): boolean;
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
  private readonly incomingReferencesByTarget = new Map<string, Promise<ResolvedResourceReference[]>>();
  private readonly referencesByDocument = new Map<string, ResolvedReferencesCacheEntry>();
  private resourcePathResolver: ResourcePathResolver | null = null;
  private childModelReferencesByParent: Promise<ReadonlyMap<string, ResolvedResourceReference[]>> | null = null;

  constructor(private readonly workspaceCache: ResourceGraphWorkspaceCache = new ResourceGraphWorkspaceCache()) { }

  invalidate(): void {
    this.workspaceCache.invalidate();
    this.incomingReferencesByTarget.clear();
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
    const targetKey = resourceUriKey(targetUri);
    const cachedReferences = this.incomingReferencesByTarget.get(targetKey);
    if (cachedReferences) {
      return cachedReferences;
    }

    const references = this.collectIncomingReferences(targetUri).catch(error => {
      this.incomingReferencesByTarget.delete(targetKey);
      throw error;
    });
    this.incomingReferencesByTarget.set(targetKey, references);
    return references;
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

  private async collectIncomingReferences(targetUri: vscode.Uri): Promise<ResolvedResourceReference[]> {
    const targetKey = resourceUriKey(targetUri);
    const search = createIncomingReferenceSearch(targetUri);
    if (!search || search.values.size === 0) {
      return [];
    }

    const documents = await collectResourceDocuments(this.workspaceCache, search);
    const references = documents.flatMap(document =>
      this.getReferences(document)
        .filter(reference => reference.targetUri !== null && resourceUriKey(reference.targetUri) === targetKey)
    );

    return uniqueResolvedReferences(references);
  }

  private getResourcePathResolver(): ResourcePathResolver {
    if (!this.resourcePathResolver) {
      this.resourcePathResolver = createResourcePathResolver();
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

export function isModelDocumentPath(fileName: string): boolean {
  return /[\\/]models[\\/].+\.json$/i.test(fileName);
}

export function resourceUriKey(uri: vscode.Uri): string {
  const key = uri.scheme === "file" ? path.normalize(uri.fsPath) : uri.toString();
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function createIncomingReferenceSearch(targetUri: vscode.Uri): IncomingReferenceSearch | null {
  const targetResource = getAssetResource(targetUri);
  if (!targetResource) {
    return null;
  }

  const values = new Set<string>();
  for (const rawPath of getPossibleReferencePaths(targetResource.resourcePath)) {
    addSearchValues(values, targetResource.namespace, rawPath);
  }

  return {
    values,
    matchesText: (text: string) => {
      if (text.includes("\\u")) {
        return true;
      }

      for (const value of values) {
        if (text.includes(value)) {
          return true;
        }
      }

      return false;
    }
  };
}

function getAssetResource(uri: vscode.Uri): { namespace: string; resourcePath: string } | null {
  if (uri.scheme !== "file") {
    return null;
  }

  const normalizedPath = path.normalize(uri.fsPath);
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");

  if (assetsIndex < 0 || segments.length <= assetsIndex + 2) {
    return null;
  }

  return {
    namespace: segments[assetsIndex + 1],
    resourcePath: segments.slice(assetsIndex + 2).join("/")
  };
}

function getPossibleReferencePaths(resourcePath: string): Set<string> {
  const paths = new Set<string>();
  const normalizedResourcePath = resourcePath.replaceAll("\\", "/");
  const pathWithoutExtension = stripExtension(normalizedResourcePath);
  const targetRoots = [
    "",
    "models",
    "textures",
    "textures/particle",
    "textures/entity",
    "textures/entity/bed",
    "textures/entity/chest",
    "textures/entity/shulker",
    "textures/entity/signs",
    "textures/entity/signs/hanging",
    "textures/effect",
    "textures/gui/sprites/hud/locator_bar_dot",
    "font",
    "shaders",
    "shaders/core",
    "shaders/include",
    "sounds"
  ];

  for (const targetRoot of targetRoots) {
    addReferencePathForTargetRoot(paths, normalizedResourcePath, pathWithoutExtension, targetRoot);
  }

  addEquipmentReferencePath(paths, normalizedResourcePath, pathWithoutExtension);
  return paths;
}

function addReferencePathForTargetRoot(
  paths: Set<string>,
  resourcePath: string,
  pathWithoutExtension: string,
  targetRoot: string
): void {
  const normalizedRoot = targetRoot.length > 0 ? `${targetRoot}/` : "";
  if (targetRoot.length > 0 && !resourcePath.startsWith(normalizedRoot)) {
    return;
  }

  const rawPath = targetRoot.length > 0 ? resourcePath.slice(normalizedRoot.length) : resourcePath;
  const rawPathWithoutExtension = targetRoot.length > 0
    ? pathWithoutExtension.slice(normalizedRoot.length)
    : pathWithoutExtension;

  if (rawPathWithoutExtension.length > 0) {
    paths.add(rawPathWithoutExtension);
  }

  if (rawPath.length > 0) {
    paths.add(rawPath);
  }
}

function addEquipmentReferencePath(paths: Set<string>, resourcePath: string, pathWithoutExtension: string): void {
  const equipmentRoot = "textures/entity/equipment/";
  if (!resourcePath.startsWith(equipmentRoot)) {
    return;
  }

  const rawPath = resourcePath.slice(equipmentRoot.length);
  const rawPathWithoutExtension = pathWithoutExtension.slice(equipmentRoot.length);
  const slashIndex = rawPath.indexOf("/");

  if (slashIndex < 0) {
    return;
  }

  const texturePath = rawPath.slice(slashIndex + 1);
  const texturePathWithoutExtension = rawPathWithoutExtension.slice(slashIndex + 1);

  if (texturePathWithoutExtension.length > 0) {
    paths.add(texturePathWithoutExtension);
  }

  if (texturePath.length > 0) {
    paths.add(texturePath);
  }
}

function addSearchValues(values: Set<string>, namespace: string, rawPath: string): void {
  const normalizedPath = rawPath.replaceAll("\\", "/");
  addJsonStringValues(values, `${namespace}:${normalizedPath}`);
  addJsonStringValues(values, `${namespace.toLowerCase()}:${normalizedPath.toLowerCase()}`);

  if (namespace === "minecraft") {
    addJsonStringValues(values, normalizedPath);
    addJsonStringValues(values, normalizedPath.toLowerCase());
  }
}

function addJsonStringValues(values: Set<string>, value: string): void {
  values.add(JSON.stringify(value));

  if (value.includes("/")) {
    values.add(JSON.stringify(value.replaceAll("/", "\\")));
    values.add(JSON.stringify(value).replaceAll("/", "\\/"));
  }
}

function stripExtension(value: string): string {
  const extension = path.posix.extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
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

async function collectResourceDocuments(
  workspaceCache: ResourceGraphWorkspaceCache,
  search?: IncomingReferenceSearch
): Promise<ResourceGraphDocument[]> {
  const documentsByKey = new Map<string, ResourceGraphDocument>();

  for (const document of vscode.workspace.textDocuments) {
    if (
      isResourceReferenceFileName(document.fileName) &&
      (!search || search.matchesText(document.getText()))
    ) {
      documentsByKey.set(resourceUriKey(document.uri), document);
    }
  }

  const fileUris = (await workspaceCache.getResourceReferenceUris()).filter(uri => !documentsByKey.has(resourceUriKey(uri)));
  const fileDocuments = await mapLimit(fileUris, 24, async uri => {
    try {
      return await loadResourceGraphDocumentIfMatching(uri, search);
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

async function loadResourceGraphDocumentIfMatching(
  uri: vscode.Uri,
  search?: IncomingReferenceSearch
): Promise<ResourceGraphDocument | null> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString("utf8");

  if (search && !search.matchesText(text)) {
    return null;
  }

  return {
    uri,
    languageId: "json",
    fileName: uri.fsPath,
    getText: () => text
  };
}

async function collectResourceReferenceUris(): Promise<vscode.Uri[]> {
  const urisByKey = new Map<string, vscode.Uri>();
  const workspaceUris = [
    ...(await vscode.workspace.findFiles("**/assets/**/*.json", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.vsh", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.fsh", "**/node_modules/**")),
    ...(await vscode.workspace.findFiles("**/assets/*/shaders/**/*.glsl", "**/node_modules/**"))
  ];

  for (const uri of workspaceUris) {
    if (isResourceReferenceFileName(uri.fsPath)) {
      urisByKey.set(resourceUriKey(uri), uri);
    }
  }

  const defaultAssetsPath = vscode.workspace.getConfiguration().get<string>("McResHelper.defaultMcAssetsPath");
  if (defaultAssetsPath) {
    for (const root of await getDefaultAssetsRoots(defaultAssetsPath)) {
      for (const uri of await collectResourceReferenceUrisInRoot(root)) {
        urisByKey.set(resourceUriKey(uri), uri);
      }
    }
  }

  return [...urisByKey.values()];
}

async function collectWorkspaceBlockstateUris(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles("**/assets/*/blockstates/*.json", "**/node_modules/**");
}

async function collectModelDocumentUris(): Promise<vscode.Uri[]> {
  const urisByKey = new Map<string, vscode.Uri>();
  const workspaceUris = [
    ...(await vscode.workspace.findFiles("**/assets/*/models/**/*.json", "**/node_modules/**"))
  ];

  for (const uri of workspaceUris) {
    urisByKey.set(resourceUriKey(uri), uri);
  }

  const defaultAssetsPath = vscode.workspace.getConfiguration().get<string>("McResHelper.defaultMcAssetsPath");
  if (defaultAssetsPath) {
    for (const root of await getDefaultAssetsRoots(defaultAssetsPath)) {
      for (const uri of await collectResourceReferenceUrisInRoot(root)) {
        if (isModelDocumentPath(uri.fsPath)) {
          urisByKey.set(resourceUriKey(uri), uri);
        }
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

async function collectResourceReferenceUrisInRoot(directory: string): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  await collectResourceReferenceUrisInto(directory, uris);
  return uris;
}

async function collectResourceReferenceUrisInto(directory: string, uris: vscode.Uri[]): Promise<void> {
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
        await collectResourceReferenceUrisInto(entryPath, uris);
      }
    } else if (entry.isFile() && isResourceReferenceFileName(entryPath)) {
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

export function isResourceGraphDocumentPath(fileName: string): boolean {
  return isResourceReferenceFileName(fileName) ||
    /[\\/]assets[\\/][^\\/]+[\\/]shaders[\\/]include[\\/].+\.(?:glsl|vsh|fsh)$/i.test(fileName);
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
