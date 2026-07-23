import * as vscode from "vscode";
import {
  overlayApplies,
  parsePackMetadata,
  uniqueValues
} from "../../../packages/mc-assets/src";
import {
  createStableResourceProjectRevision,
  joinResourceProjectUri,
  resourceProjectUriBasename,
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type ResourceLayerDescriptor,
  type ResourcePackProjectContextDto,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import type { ResourcePackProjectService } from "../../resourceProject";
import { mapWithConcurrency } from "../../utils/asyncWorkPool";
import type { ResourceContributionRequest, ResourceLayerRole } from "../core";
import type { ArchiveResourceStore } from "../virtualFs/archiveResourceStore";
import type { PhysicalAssetScannedDocument } from "./physicalAssetReferenceAdapter";
import type {
  PhysicalAssetOwnedOutputLookup,
  PhysicalAssetProjectScan,
  PhysicalAssetProjectSource
} from "./physicalAssetProvider";
import { isResourceDocumentUriWithin } from "./resourceDocumentUri";

const maximumLayerDepth = 32;
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
const ignoredDirectories = new Set([".git", "node_modules", "out"]);

interface ScannableLayer {
  descriptor: ResourceLayerDescriptor;
  /** Effective root order: active overlays first, then configured/base roots. */
  assetsRootUris: readonly SerializedResourceUri[];
}

/** Project-bounded VS Code scanner. It is invoked only by an explicit provider request. */
export class VscodePhysicalAssetSource implements PhysicalAssetProjectSource {
  private ownedOutputLookup?: PhysicalAssetOwnedOutputLookup;

  public constructor(
    private readonly projects: ResourcePackProjectService,
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
    const scanned = await Promise.all(layers.map(layer => this.scanLayer(layer, signal)));
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
    const localRoots = await packAssetsRoots(
      context.outputPackRootUri,
      [context.outputAssetsRootUri],
      signal
    );
    const layers: ScannableLayer[] = [{
      descriptor: context.localLayer,
      assetsRootUris: localRoots
    }];
    const unavailableUris: SerializedResourceUri[] = [];
    for (const descriptor of [
      ...context.externalLayers,
      ...(context.vanillaLayer ? [context.vanillaLayer] : [])
    ]) {
      throwIfAborted(signal);
      let layerRootUri = descriptor.rootUri;
      if (descriptor.source === "zip" || descriptor.source === "clientJar") {
        if (!this.archiveResources) {
          unavailableUris.push(descriptor.rootUri);
          continue;
        }
        try {
          layerRootUri = (await this.archiveResources.mountLayer(descriptor, signal)).rootUri;
        } catch {
          unavailableUris.push(descriptor.rootUri);
          continue;
        }
      } else if (descriptor.source !== "directory") {
        unavailableUris.push(descriptor.rootUri);
        continue;
      }
      const baseRoots = await configuredAssetsRoots(layerRootUri);
      if (baseRoots.length === 0) {
        unavailableUris.push(descriptor.rootUri);
        continue;
      }
      const packRoot = resourceProjectUriParent(baseRoots[0]);
      const assetsRootUris = packRoot
        ? await packAssetsRoots(packRoot, baseRoots, signal)
        : baseRoots;
      layers.push({ descriptor, assetsRootUris });
    }
    return { layers, unavailableUris };
  }

  private async scanLayer(
    layer: ScannableLayer,
    signal: AbortSignal
  ): Promise<{ documents: PhysicalAssetScannedDocument[]; failedUris: string[] }> {
    const discovered = await Promise.all(layer.assetsRootUris.map(rootUri =>
      collectLayerFileUris(rootUri, signal)
    ));
    const byUri = new Map<string, { uri: vscode.Uri; assetsRootUri: SerializedResourceUri }>();
    layer.assetsRootUris.forEach((assetsRootUri, index) => {
      for (const uri of discovered[index].uris) {
        if (!byUri.has(uri.toString())) {
          byUri.set(uri.toString(), { uri, assetsRootUri });
        }
      }
    });
    for (const document of vscode.workspace.textDocuments) {
      if (!isIndexedFile(document.uri)) {
        continue;
      }
      const assetsRootUri = layer.assetsRootUris.find(rootUri =>
        isResourceDocumentUriWithin(document.uri, rootUri)
      );
      if (assetsRootUri) {
        byUri.set(document.uri.toString(), { uri: document.uri, assetsRootUri });
      }
    }

    const loaded = await mapWithConcurrency([...byUri.values()], 16, item =>
      loadScannedDocument(item.uri, item.assetsRootUri, layer, signal)
    );
    const effectiveDocuments = new Map<string, PhysicalAssetScannedDocument>();
    for (const document of loaded) {
      if (document && !effectiveDocuments.has(document.outputPath)) {
        effectiveDocuments.set(document.outputPath, document);
      }
    }
    return {
      documents: [...effectiveDocuments.values()],
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
  while (queue.length > 0) {
    throwIfAborted(signal);
    const current = queue.shift()!;
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
  signal: AbortSignal
): Promise<PhysicalAssetScannedDocument | null> {
  throwIfAborted(signal);
  const openDocument = vscode.workspace.textDocuments.find(document =>
    document.uri.toString() === uri.toString()
  );
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

async function configuredAssetsRoots(rootUri: SerializedResourceUri): Promise<SerializedResourceUri[]> {
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
  for (const candidate of candidates) {
    const identity = resourceProjectUriIdentity(candidate);
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    const type = await statType(candidate);
    if (type !== null && (type & vscode.FileType.Directory) !== 0) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function packAssetsRoots(
  packRootUri: SerializedResourceUri,
  baseRoots: readonly SerializedResourceUri[],
  signal: AbortSignal
): Promise<SerializedResourceUri[]> {
  throwIfAborted(signal);
  let metadata: ReturnType<typeof parsePackMetadata> | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(
      joinResourceProjectUri(packRootUri, "pack.mcmeta"),
      true
    ));
    metadata = parsePackMetadata(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
  } catch {
    metadata = undefined;
  }
  const overlays = metadata
    ? metadata.overlays.filter(overlayApplies).map(overlay =>
        joinResourceProjectUri(packRootUri, overlay.directory, "assets")
      ).reverse()
    : [];
  const result: SerializedResourceUri[] = [];
  const identities = new Set<string>();
  for (const rootUri of [...overlays, ...baseRoots]) {
    const identity = resourceProjectUriIdentity(rootUri);
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    const type = await statType(rootUri);
    if (type !== null && (type & vscode.FileType.Directory) !== 0) {
      result.push(rootUri);
    }
  }
  return result.length > 0 ? result : [...baseRoots];
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

async function statType(uri: SerializedResourceUri): Promise<vscode.FileType | null> {
  try {
    return (await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true))).type;
  } catch {
    return null;
  }
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Physical asset scan was cancelled.");
  }
}
