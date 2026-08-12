import * as vscode from "vscode";
import {
  overlayApplies,
  parsePackMetadata,
  uniqueValues
} from "../../../packages/mc-assets/src";
import {
  packMetadataFileName,
  createStableResourceProjectRevision,
  joinResourceProjectUri,
  resourceProjectUriBasename,
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type ResourceLayerDescriptor,
  type ResourcePackProjectContextDto,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import { LruCache } from "../../../packages/shared-utils/src";
import { mapWithConcurrency } from "../../utils/asyncWorkPool";
import { throwIfAborted } from "../../utils/abortError";
import { ignoredWorkspaceDirectoryNames } from "../../resources/resourceSurfaceRegistry";
import type { ResourceContributionRequest, ResourceLayerRole } from "../core";
import { sameResourceUri } from "../core/resourceUriIdentity";
import type { ArchiveResourceStore } from "../virtualFs/archiveResourceStore";
import type { PhysicalAssetScannedDocument } from "./physicalAssetReferenceAdapter";
import type {
  PhysicalAssetOwnedOutputLookup,
  PhysicalAssetProjectScan,
  PhysicalAssetProjectSource
} from "./physicalAssetProvider";
import {
  resolveExactPhysicalAssetDefinition,
  type PhysicalAssetDefinitionLayerRoots,
  type PhysicalAssetDefinitionRequest,
  type PhysicalAssetDefinitionResolution,
  type PhysicalAssetDefinitionResolver,
  type PhysicalAssetDefinitionResolverHost,
  type PhysicalAssetDefinitionTargetProbe
} from "./physicalAssetDefinitionResolver";
import { isResourceDocumentUriWithin } from "./resourceDocumentUri";

const maximumLayerDepth = 32;
/** Narrower indexing subset of mc-assets' textResourceFileExtensions (scan policy). */
const textExtensions = new Set([".json", ".lang", ".properties", ".vsh", ".fsh", ".glsl"]);
const indexedExtensions = new Set([
  ...textExtensions,
  ".png",
  ".ogg",
  ".ttf",
  ".otf",
  ".ttc",
  ".woff",
  ".woff2"
]);
const ignoredDirectories = ignoredWorkspaceDirectoryNames;
const maximumCachedLayerPlans = 256;
const maximumCachedExactDefinitions = 4_096;
// Recursive workspace watchers are not authoritative for configured packs outside
// the workspace. Keep a short verification window even when the context is stable.
const layerPlanVerificationWindowMs = 1_000;

interface ScannableLayer {
  descriptor: ResourceLayerDescriptor;
  /** Effective root order: active overlays first, then configured/base roots. */
  assetsRootUris: readonly SerializedResourceUri[];
}

type LayerAssetsRootDiscovery =
  | {
      status: "ready";
      assetsRootUris: readonly SerializedResourceUri[];
      complete: boolean;
    }
  | { status: "unsupported" | "unavailable" };

interface CachedLayerAssetsRootDiscovery {
  readonly projectId: string;
  readonly expiresAt: number;
  readonly value: Extract<LayerAssetsRootDiscovery, { status: "ready" }>;
}

interface CachedExactDefinition {
  readonly projectId: string;
  readonly expiresAt: number;
  readonly value: Extract<PhysicalAssetDefinitionResolution, { status: "resolved" | "missing" }>;
}

export interface PhysicalAssetProjectContextStore {
  getCachedContext(projectId: string): ResourcePackProjectContextDto | undefined;
}

/** Project-bounded VS Code scanner. It is invoked only by an explicit provider request. */
export class VscodePhysicalAssetSource implements
  PhysicalAssetProjectSource,
  PhysicalAssetDefinitionResolver,
  PhysicalAssetDefinitionResolverHost {
  private ownedOutputLookup?: PhysicalAssetOwnedOutputLookup;
  private readonly layerPlanCache = new LruCache<string, CachedLayerAssetsRootDiscovery>(
    maximumCachedLayerPlans
  );
  private readonly exactDefinitionCache = new LruCache<string, CachedExactDefinition>(
    maximumCachedExactDefinitions
  );
  /** Prevents an in-flight probe from repopulating caches after any invalidation. */
  private cacheWriteGeneration = 0;

  public constructor(
    private readonly projects: PhysicalAssetProjectContextStore,
    private readonly archiveResources?: Pick<ArchiveResourceStore, "mountLayer">
  ) {}

  public setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void } {
    this.ownedOutputLookup = lookup;
    return {
      dispose: () => {
        if (this.ownedOutputLookup === lookup) {
          this.ownedOutputLookup = undefined;
        }
      }
    };
  }

  public async resolveExactDefinition(
    request: PhysicalAssetDefinitionRequest,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionResolution> {
    throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
    const cacheWriteGeneration = this.cacheWriteGeneration;
    const cacheKey = exactDefinitionCacheKey(
      request,
      this.ownedOutputLookup?.getOwnershipRevision(request.context.projectId)
    );
    const cached = this.exactDefinitionCache.get(cacheKey);
    if (cached && cached.expiresAt >= Date.now()) {
      return cloneExactDefinitionResolution(cached.value);
    }
    if (cached) {
      this.exactDefinitionCache.delete(cacheKey);
    }

    const resolution = await resolveExactPhysicalAssetDefinition(request, this, signal);
    throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
    if (
      cacheWriteGeneration === this.cacheWriteGeneration
      && (resolution.status === "resolved" || resolution.status === "missing")
    ) {
      this.exactDefinitionCache.set(cacheKey, {
        projectId: request.context.projectId,
        expiresAt: Date.now() + layerPlanVerificationWindowMs,
        value: cloneExactDefinitionResolution(resolution)
      });
    }
    return resolution;
  }

  public invalidateProjects(projectIds: readonly string[]): void {
    if (projectIds.length === 0) {
      return;
    }
    const affected = new Set(projectIds);
    this.cacheWriteGeneration++;
    for (const [key, entry] of this.layerPlanCache.entries()) {
      if (affected.has(entry.projectId)) {
        this.layerPlanCache.delete(key);
      }
    }
    for (const [key, entry] of this.exactDefinitionCache.entries()) {
      if (affected.has(entry.projectId)) {
        this.exactDefinitionCache.delete(key);
      }
    }
  }

  public invalidateAll(): void {
    this.cacheWriteGeneration++;
    this.layerPlanCache.clear();
    this.exactDefinitionCache.clear();
  }

  public async getOrderedAssetsRootUris(
    context: ResourcePackProjectContextDto,
    layer: ResourceLayerDescriptor,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionLayerRoots> {
    const cancellation = signal ?? new AbortController().signal;
    const roots = await this.resolveLayerAssetsRootUris(context, layer, cancellation);
    if (roots.status !== "ready") {
      return roots;
    }
    return roots.complete
      ? { status: "ready", assetsRootUris: roots.assetsRootUris }
      : { status: "unavailable" };
  }

  private async resolveLayerAssetsRootUris(
    context: ResourcePackProjectContextDto,
    layer: ResourceLayerDescriptor,
    cancellation: AbortSignal
  ): Promise<LayerAssetsRootDiscovery> {
    throwIfAborted(cancellation, "Physical asset Definition resolution was cancelled.");
    const cacheWriteGeneration = this.cacheWriteGeneration;
    const cacheKey = layerPlanCacheKey(context, layer);
    const cached = this.layerPlanCache.get(cacheKey);
    if (cached && cached.expiresAt >= Date.now()) {
      return cached.value;
    }

    const discovered = await this.discoverLayerAssetsRootUris(context, layer, cancellation);
    throwIfAborted(cancellation, "Physical asset Definition resolution was cancelled.");
    if (
      cacheWriteGeneration === this.cacheWriteGeneration
      && discovered.status === "ready"
      && discovered.complete
    ) {
      this.layerPlanCache.set(cacheKey, {
        projectId: context.projectId,
        expiresAt: Date.now() + layerPlanVerificationWindowMs,
        value: discovered
      });
    }
    return discovered;
  }

  private async discoverLayerAssetsRootUris(
    context: ResourcePackProjectContextDto,
    layer: ResourceLayerDescriptor,
    cancellation: AbortSignal
  ): Promise<LayerAssetsRootDiscovery> {
    if (layer.layerId === context.localLayer.layerId) {
      const roots = await packAssetsRoots(
        context.outputPackRootUri,
        [context.outputAssetsRootUri],
        cancellation
      );
      return { status: "ready", ...roots };
    }

    let layerRootUri = layer.rootUri;
    if (layer.source === "zip" || layer.source === "clientJar") {
      if (!this.archiveResources) {
        return { status: "unsupported" };
      }
      try {
        layerRootUri = (await this.archiveResources.mountLayer(layer, cancellation)).rootUri;
      } catch {
        return { status: "unavailable" };
      }
    } else if (layer.source !== "directory") {
      return { status: "unsupported" };
    }

    const configured = await configuredAssetsRoots(layerRootUri, cancellation);
    if (configured.assetsRootUris.length === 0) {
      return { status: "unavailable" };
    }
    const packRoot = resourceProjectUriParent(configured.assetsRootUris[0]);
    const roots = packRoot
      ? await packAssetsRoots(packRoot, configured.assetsRootUris, cancellation)
      : configured;
    return {
      status: "ready",
      assetsRootUris: roots.assetsRootUris,
      complete: configured.complete && roots.complete
    };
  }

  public async probeTargetUri(
    uri: SerializedResourceUri,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionTargetProbe> {
    if (signal) {
      throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
    }
    const target = vscode.Uri.parse(uri, true);
    if (vscode.workspace.textDocuments.some(document =>
      sameResourceUri(document.uri.toString(), target.toString())
    )) {
      return "file";
    }
    try {
      const stat = await vscode.workspace.fs.stat(target);
      if ((stat.type & vscode.FileType.File) !== 0) {
        return "file";
      }
      return (stat.type & vscode.FileType.Directory) !== 0 ? "missing" : "unavailable";
    } catch (error) {
      return isFileNotFoundError(error)
        ? "missing"
        : "unavailable";
    }
  }

  public isOwnedOutput(projectId: string, outputPath: string): boolean {
    return this.ownedOutputLookup?.getOwnedOutputPaths(projectId).has(outputPath) ?? false;
  }

  public async scanProject(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<PhysicalAssetProjectScan> {
    const context = this.projects.getCachedContext(request.projectId);
    if (!context) {
      return {
        revision: "not-probed",
        documents: [],
        coverage: { status: "unavailable", reason: "notProbed" }
      };
    }

    const { layers, unavailableUris } = await this.resolveScannableLayers(context, signal);
    const openDocumentsByUri = indexOpenTextDocuments(vscode.workspace.textDocuments);
    const scanned = await Promise.all(layers.map(layer =>
      this.scanLayer(layer, openDocumentsByUri, signal)
    ));
    const failedUris = [...unavailableUris, ...scanned.flatMap(result => result.failedUris)];
    const documents = scanned.flatMap(result => result.documents);
    const ownedOutputPaths = this.ownedOutputLookup?.getOwnedOutputPaths(request.projectId)
      ?? new Set<string>();
    const ownershipRevision = this.ownedOutputLookup?.getOwnershipRevision(request.projectId);
    const revision = createStableResourceProjectRevision("physical-snapshot", {
      contextRevision: context.contextRevision,
      documents: documents.map(document => [document.uri, document.revision]),
      failedUris,
      ownershipRevision: ownershipRevision ?? null
    });
    return {
      revision,
      documents,
      ownedOutputPaths,
      coverage: failedUris.length === 0
        ? {
            status: "authoritative",
            revision,
            coveredScope: request.scope
          }
        : {
            status: "partial",
            revision,
            authoritativeScopes: [],
            unavailableScopes: [request.scope],
            skippedSourceUris: uniqueValues(failedUris).sort()
          }
    };
  }

  private async resolveScannableLayers(
    context: ResourcePackProjectContextDto,
    signal: AbortSignal
  ): Promise<{ layers: ScannableLayer[]; unavailableUris: SerializedResourceUri[] }> {
    const layers: ScannableLayer[] = [];
    const unavailableUris: SerializedResourceUri[] = [];
    for (const descriptor of [
      context.localLayer,
      ...context.externalLayers,
      ...(context.vanillaLayer ? [context.vanillaLayer] : [])
    ]) {
      throwIfAborted(signal, "Physical asset scan was cancelled.");
      const roots = await this.resolveLayerAssetsRootUris(context, descriptor, signal);
      if (roots.status !== "ready") {
        unavailableUris.push(descriptor.rootUri);
        continue;
      }
      layers.push({ descriptor, assetsRootUris: roots.assetsRootUris });
      if (!roots.complete) {
        unavailableUris.push(descriptor.rootUri);
      }
    }
    return { layers, unavailableUris };
  }

  private async scanLayer(
    layer: ScannableLayer,
    openDocumentsByUri: ReadonlyMap<string, vscode.TextDocument>,
    signal: AbortSignal
  ): Promise<{ documents: PhysicalAssetScannedDocument[]; failedUris: string[] }> {
    const discovered = await Promise.all(layer.assetsRootUris.map(rootUri =>
      collectLayerFileUris(rootUri, signal)
    ));
    const byUri = new Map<string, {
      uri: vscode.Uri;
      assetsRootUri: SerializedResourceUri;
      rootPriority: number;
    }>();
    layer.assetsRootUris.forEach((assetsRootUri, index) => {
      for (const uri of discovered[index].uris) {
        if (!byUri.has(uri.toString())) {
          byUri.set(uri.toString(), { uri, assetsRootUri, rootPriority: index });
        }
      }
    });
    for (const document of openDocumentsByUri.values()) {
      const rootPriority = layer.assetsRootUris.findIndex(rootUri =>
        isResourceDocumentUriWithin(document.uri, rootUri)
      );
      const assetsRootUri = layer.assetsRootUris[rootPriority];
      if (assetsRootUri !== undefined) {
        byUri.set(document.uri.toString(), {
          uri: document.uri,
          assetsRootUri,
          rootPriority
        });
      }
    }

    const loaded = await mapWithConcurrency([...byUri.values()], 16, async item => ({
      document: await loadScannedDocument(
        item.uri,
        item.assetsRootUri,
        layer,
        openDocumentsByUri.get(item.uri.toString()),
        signal
      ),
      rootPriority: item.rootPriority
    }));
    const effectiveDocuments = new Map<string, {
      document: PhysicalAssetScannedDocument;
      rootPriority: number;
    }>();
    for (const item of loaded) {
      if (!item.document) {
        continue;
      }
      const current = effectiveDocuments.get(item.document.outputPath);
      if (!current || item.rootPriority < current.rootPriority) {
        effectiveDocuments.set(item.document.outputPath, {
          document: item.document,
          rootPriority: item.rootPriority
        });
      }
    }
    return {
      documents: [...effectiveDocuments.values()].map(item => item.document),
      failedUris: discovered.flatMap(result => result.failedUris)
    };
  }
}

async function collectLayerFileUris(
  rootUri: SerializedResourceUri,
  signal: AbortSignal
): Promise<{ uris: vscode.Uri[]; failedUris: string[] }> {
  const uris: vscode.Uri[] = [];
  const failedUris: string[] = [];
  const queue: Array<{ uri: vscode.Uri; depth: number }> = [{
    uri: vscode.Uri.parse(rootUri, true),
    depth: 0
  }];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    throwIfAborted(signal, "Physical asset scan was cancelled.");
    const current = queue[queueIndex];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(current.uri);
    } catch {
      failedUris.push(current.uri.toString());
      continue;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(current.uri, name);
      if ((type & vscode.FileType.File) !== 0 && isIndexedFile(child)) {
        uris.push(child);
      } else if (
        (type & vscode.FileType.Directory) !== 0
        && current.depth < maximumLayerDepth
        && !ignoredDirectories.has(name.toLowerCase())
      ) {
        queue.push({ uri: child, depth: current.depth + 1 });
      }
    }
  }
  return { uris, failedUris };
}

async function loadScannedDocument(
  uri: vscode.Uri,
  assetsRootUri: SerializedResourceUri,
  layer: ScannableLayer,
  openDocument: vscode.TextDocument | undefined,
  signal: AbortSignal
): Promise<PhysicalAssetScannedDocument | null> {
  throwIfAborted(signal, "Physical asset scan was cancelled.");
  let stat: vscode.FileStat | undefined;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    if (!openDocument) {
      return null;
    }
  }

  const extension = fileExtension(uri.path);
  let text = "";
  let version: number | undefined;
  let languageId = languageIdFor(extension);
  if (openDocument) {
    text = openDocument.getText();
    version = openDocument.version;
    languageId = openDocument.languageId;
  } else if (textExtensions.has(extension)) {
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return null;
    }
  }

  const uriString = uri.toString();
  return {
    uri: uriString,
    fileName: uri.scheme === "file" ? uri.fsPath : uri.path,
    languageId,
    version,
    revision: createStableResourceProjectRevision("physical-document", {
      uri: uriString,
      openVersion: version,
      mtime: stat?.mtime,
      size: stat?.size,
      ...(textExtensions.has(extension) ? { text } : {})
    }),
    layerId: layer.descriptor.layerId,
    layerRole: layer.descriptor.role as ResourceLayerRole,
    outputPath: packRelativeOutputPath(uri, assetsRootUri),
    getText: () => text
  };
}

function indexOpenTextDocuments(
  documents: readonly vscode.TextDocument[]
): ReadonlyMap<string, vscode.TextDocument> {
  const byUri = new Map<string, vscode.TextDocument>();
  for (const document of documents) {
    if (isIndexedFile(document.uri) && !byUri.has(document.uri.toString())) {
      byUri.set(document.uri.toString(), document);
    }
  }
  return byUri;
}

interface AssetsRootDiscovery {
  assetsRootUris: SerializedResourceUri[];
  /** False when an I/O failure makes the effective root order uncertain. */
  complete: boolean;
}

async function configuredAssetsRoots(
  rootUri: SerializedResourceUri,
  signal: AbortSignal
): Promise<AssetsRootDiscovery> {
  const candidates: SerializedResourceUri[] = [];
  if (resourceProjectUriBasename(rootUri).toLowerCase() === "assets") {
    candidates.push(rootUri);
  }
  const parent = resourceProjectUriParent(rootUri);
  if (parent && resourceProjectUriBasename(parent).toLowerCase() === "assets") {
    candidates.push(parent);
  }
  candidates.push(joinResourceProjectUri(rootUri, "assets"));
  const existing: SerializedResourceUri[] = [];
  const identities = new Set<string>();
  let complete = true;
  for (const candidate of candidates) {
    throwIfAborted(signal, "Physical asset root discovery was cancelled.");
    const identity = resourceProjectUriIdentity(candidate);
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    const probe = await probeUriType(candidate);
    throwIfAborted(signal, "Physical asset root discovery was cancelled.");
    if (probe.status === "unavailable") {
      complete = false;
    } else if (probe.status === "ready" && (probe.type & vscode.FileType.Directory) !== 0) {
      existing.push(candidate);
    }
  }
  return { assetsRootUris: existing, complete };
}

async function packAssetsRoots(
  packRootUri: SerializedResourceUri,
  baseRoots: readonly SerializedResourceUri[],
  signal: AbortSignal
): Promise<AssetsRootDiscovery> {
  throwIfAborted(signal, "Physical asset scan was cancelled.");
  let metadata: ReturnType<typeof parsePackMetadata> | undefined;
  let complete = true;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(
      joinResourceProjectUri(packRootUri, packMetadataFileName),
      true
    ));
    metadata = parsePackMetadata(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
  } catch (error) {
    metadata = undefined;
    if (!isFileNotFoundError(error)) {
      complete = false;
    }
  }
  throwIfAborted(signal, "Physical asset scan was cancelled.");
  const overlays = metadata
    ? metadata.overlays.filter(overlayApplies).map(overlay =>
        joinResourceProjectUri(packRootUri, overlay.directory, "assets")
      ).reverse()
    : [];
  const result: SerializedResourceUri[] = [];
  const identities = new Set<string>();
  for (const rootUri of [...overlays, ...baseRoots]) {
    throwIfAborted(signal, "Physical asset root discovery was cancelled.");
    const identity = resourceProjectUriIdentity(rootUri);
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    const probe = await probeUriType(rootUri);
    throwIfAborted(signal, "Physical asset root discovery was cancelled.");
    if (probe.status === "unavailable") {
      complete = false;
    } else if (probe.status === "ready" && (probe.type & vscode.FileType.Directory) !== 0) {
      result.push(rootUri);
    }
  }
  return {
    assetsRootUris: result.length > 0 ? result : [...baseRoots],
    complete
  };
}

function packRelativeOutputPath(uri: vscode.Uri, assetsRootUri: SerializedResourceUri): string {
  const root = vscode.Uri.parse(assetsRootUri, true);
  const rootPath = root.path.replace(/\/+$/, "");
  const relativePath = uri.path.slice(rootPath.length).replace(/^\/+/, "");
  return `assets/${decodeUriPath(relativePath)}`;
}

function isIndexedFile(uri: vscode.Uri): boolean {
  return indexedExtensions.has(fileExtension(uri.path));
}

function fileExtension(fileName: string): string {
  const slash = fileName.lastIndexOf("/");
  const dot = fileName.lastIndexOf(".");
  return dot > slash ? fileName.slice(dot).toLowerCase() : "";
}

function languageIdFor(extension: string): string {
  return extension === ".json" ? "json" : extension === ".properties" ? "properties" : "plaintext";
}

function layerPlanCacheKey(
  context: ResourcePackProjectContextDto,
  layer: ResourceLayerDescriptor
): string {
  return [
    context.projectId,
    context.contextRevision,
    layer.layerId,
    layer.source,
    layer.rootUri,
    layer.metadataRevision
  ].join("\0");
}

function exactDefinitionCacheKey(
  request: PhysicalAssetDefinitionRequest,
  ownershipRevision: string | undefined
): string {
  return [
    request.context.projectId,
    request.context.contextRevision,
    request.scope,
    request.target.kind,
    request.target.id,
    ownershipRevision ?? ""
  ].join("\0");
}

function cloneExactDefinitionResolution<T extends Extract<
  PhysicalAssetDefinitionResolution,
  { status: "resolved" | "missing" }
>>(resolution: T): T {
  return {
    ...resolution,
    target: { ...resolution.target },
    ...(resolution.status === "resolved"
      ? {
          definition: {
            ...resolution.definition,
            layer: { ...resolution.definition.layer }
          }
        }
      : {})
  } as T;
}

type UriTypeProbe =
  | { status: "ready"; type: vscode.FileType }
  | { status: "missing" | "unavailable" };

async function probeUriType(uri: SerializedResourceUri): Promise<UriTypeProbe> {
  try {
    return {
      status: "ready",
      type: (await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true))).type
    };
  } catch (error) {
    return { status: isFileNotFoundError(error) ? "missing" : "unavailable" };
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
