import { uniqueValues } from "../../../packages/mc-assets/src";
import { throwIfAborted } from "../../utils/abortError";
import {
  createStableResourceProjectRevision,
  resourceProjectUriIdentity,
  type ResourceLayerDescriptor,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import {
  ZipArchive,
  ZipArchiveError,
  type ZipArchiveDirectoryEntry,
  type ZipArchiveEntryStat,
  type ZipArchiveOptions
} from "./zipArchive";

export const readOnlyArchiveResourceScheme = "mcres-archive";

export interface ArchiveResourceSourceStat {
  type: "file" | "directory";
  ctime: number;
  mtime: number;
  size: number;
}

/** Host boundary for archive bytes; remote URI schemes remain host-owned. */
export interface ArchiveResourceSourceHost {
  stat(uri: SerializedResourceUri): Promise<ArchiveResourceSourceStat | null>;
  readFile(uri: SerializedResourceUri): Promise<Uint8Array>;
}

export interface ReadOnlyArchiveMount {
  layerId: string;
  source: "zip" | "clientJar";
  sourceUri: SerializedResourceUri;
  rootUri: SerializedResourceUri;
  revision: string;
}

export type ArchiveResourceMountEvent = ReadOnlyArchiveMount;

export interface ArchiveResourceInvalidationEvent {
  sourceUri: SerializedResourceUri;
  invalidatedRootUris: readonly SerializedResourceUri[];
  layerIds: readonly string[];
}

export interface ArchiveResourceStoreOptions {
  zip?: ZipArchiveOptions;
}

export type ArchiveResourceStoreErrorCode =
  | "unsupportedLayer"
  | "sourceUnavailable"
  | "sourceChanged"
  | "staleResourceUri"
  | "invalidResourceUri";

export class ArchiveResourceStoreError extends Error {
  public constructor(
    public readonly code: ArchiveResourceStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArchiveResourceStoreError";
  }
}

interface StoredMount extends ReadOnlyArchiveMount {
  baseId: string;
  sourceIdentity: string;
  sourceSignature: string;
  archive: ZipArchive;
}

interface PendingMount {
  sourceSignature: string;
  generation: number;
  promise: Promise<ReadOnlyArchiveMount>;
}

export interface ArchiveResourceStoreSubscription {
  dispose(): void;
}

/**
 * Lazy in-memory mount table for configured ZIP packs and vanilla client JARs.
 * A source revision receives a distinct virtual authority, so previously
 * returned URIs become invalid instead of silently resolving against new bytes.
 */
export class ArchiveResourceStore {
  private readonly mountsByAuthority = new Map<string, StoredMount>();
  private readonly currentByBaseId = new Map<string, StoredMount>();
  private readonly pendingByBaseId = new Map<string, PendingMount>();
  private readonly latestGenerationByBaseId = new Map<string, number>();
  private readonly mountListeners = new Set<(event: ArchiveResourceMountEvent) => void>();
  private readonly invalidationListeners = new Set<(
    event: ArchiveResourceInvalidationEvent
  ) => void>();
  private generation = 0;
  private disposed = false;

  public constructor(
    private readonly host: ArchiveResourceSourceHost,
    private readonly options: ArchiveResourceStoreOptions = {}
  ) {}

  public async mountLayer(
    descriptor: ResourceLayerDescriptor,
    signal: AbortSignal
  ): Promise<ReadOnlyArchiveMount> {
    this.assertActive();
    if (!isArchiveLayerDescriptor(descriptor)) {
      throw new ArchiveResourceStoreError(
        "unsupportedLayer",
        `Layer '${descriptor.layerId}' is not a ZIP or client JAR layer.`
      );
    }
    throwIfAborted(signal, "Archive resource mount was cancelled.");

    const sourceUri = descriptor.rootUri;
    const sourceIdentity = resourceProjectUriIdentity(sourceUri);
    const stat = await this.host.stat(sourceUri);
    throwIfAborted(signal, "Archive resource mount was cancelled.");
    if (!stat || stat.type !== "file") {
      throw new ArchiveResourceStoreError(
        "sourceUnavailable",
        `Archive layer source is not an accessible file: ${sourceUri}`
      );
    }
    const baseId = createStableResourceProjectRevision("archive", {
      layerId: descriptor.layerId,
      source: descriptor.source,
      sourceIdentity
    });
    const sourceSignature = createStableResourceProjectRevision("source", {
      metadataRevision: descriptor.metadataRevision,
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size
    });
    const current = this.currentByBaseId.get(baseId);
    if (current?.sourceSignature === sourceSignature) {
      return publicMount(current);
    }
    const pending = this.pendingByBaseId.get(baseId);
    if (pending?.sourceSignature === sourceSignature) {
      return await pending.promise;
    }

    const generation = ++this.generation;
    this.latestGenerationByBaseId.set(baseId, generation);
    const promise = this.loadMount(
      descriptor,
      sourceIdentity,
      stat,
      baseId,
      sourceSignature,
      generation,
      signal
    );
    this.pendingByBaseId.set(baseId, { sourceSignature, generation, promise });
    try {
      return await promise;
    } finally {
      if (this.pendingByBaseId.get(baseId)?.generation === generation) {
        this.pendingByBaseId.delete(baseId);
      }
    }
  }

  public stat(uri: SerializedResourceUri): ZipArchiveEntryStat {
    const { mount, entryPath } = this.resolveResourceUri(uri);
    return mount.archive.stat(entryPath);
  }

  public readDirectory(uri: SerializedResourceUri): readonly ZipArchiveDirectoryEntry[] {
    const { mount, entryPath } = this.resolveResourceUri(uri);
    return mount.archive.readDirectory(entryPath);
  }

  public async readFile(uri: SerializedResourceUri): Promise<Uint8Array> {
    const { mount, entryPath } = this.resolveResourceUri(uri);
    await new Promise<void>(resolve => setImmediate(resolve));
    this.assertActive();
    if (this.mountsByAuthority.get(resourceAuthority(uri)) !== mount) {
      throw new ArchiveResourceStoreError("staleResourceUri", `Archive resource URI is stale: ${uri}`);
    }
    return mount.archive.readFile(entryPath);
  }

  /** Invalidates all mounted layer identities backed by one concrete source. */
  public invalidateSource(sourceUri: SerializedResourceUri): ArchiveResourceInvalidationEvent | null {
    const sourceIdentity = resourceProjectUriIdentity(sourceUri);
    const invalidated = [...this.currentByBaseId.values()]
      .filter(mount => mount.sourceIdentity === sourceIdentity);
    if (invalidated.length === 0) {
      return null;
    }
    for (const mount of invalidated) {
      this.currentByBaseId.delete(mount.baseId);
      this.mountsByAuthority.delete(resourceAuthority(mount.rootUri));
      this.latestGenerationByBaseId.set(mount.baseId, ++this.generation);
    }
    const event: ArchiveResourceInvalidationEvent = {
      sourceUri,
      invalidatedRootUris: invalidated.map(mount => mount.rootUri),
      layerIds: uniqueValues(invalidated.map(mount => mount.layerId)).sort()
    };
    for (const listener of this.invalidationListeners) {
      listener(event);
    }
    return event;
  }

  public onDidMount(
    listener: (event: ArchiveResourceMountEvent) => void
  ): ArchiveResourceStoreSubscription {
    this.mountListeners.add(listener);
    return { dispose: () => this.mountListeners.delete(listener) };
  }

  public onDidInvalidate(
    listener: (event: ArchiveResourceInvalidationEvent) => void
  ): ArchiveResourceStoreSubscription {
    this.invalidationListeners.add(listener);
    return { dispose: () => this.invalidationListeners.delete(listener) };
  }

  public dispose(): void {
    this.disposed = true;
    this.mountsByAuthority.clear();
    this.currentByBaseId.clear();
    this.pendingByBaseId.clear();
    this.latestGenerationByBaseId.clear();
    this.mountListeners.clear();
    this.invalidationListeners.clear();
  }

  private async loadMount(
    descriptor: ResourceLayerDescriptor & { source: "zip" | "clientJar" },
    sourceIdentity: string,
    initialStat: ArchiveResourceSourceStat,
    baseId: string,
    initialSignature: string,
    generation: number,
    signal: AbortSignal
  ): Promise<ReadOnlyArchiveMount> {
    let bytes: Uint8Array;
    try {
      bytes = await this.host.readFile(descriptor.rootUri);
    } catch (error) {
      throw new ArchiveResourceStoreError(
        "sourceUnavailable",
        `Unable to read archive layer '${descriptor.rootUri}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throwIfAborted(signal, "Archive resource mount was cancelled.");
    const verifiedStat = await this.host.stat(descriptor.rootUri);
    throwIfAborted(signal, "Archive resource mount was cancelled.");
    if (!verifiedStat || verifiedStat.type !== "file" || !sameSourceStat(initialStat, verifiedStat)) {
      throw new ArchiveResourceStoreError(
        "sourceChanged",
        `Archive layer changed while it was being read: ${descriptor.rootUri}`
      );
    }
    if (this.latestGenerationByBaseId.get(baseId) !== generation) {
      throw new ArchiveResourceStoreError(
        "sourceChanged",
        `A newer archive layer revision superseded '${descriptor.rootUri}'.`
      );
    }

    let archive: ZipArchive;
    try {
      archive = ZipArchive.fromBytes(bytes, this.options.zip);
    } catch (error) {
      if (error instanceof ZipArchiveError) {
        throw error;
      }
      throw new ArchiveResourceStoreError(
        "sourceUnavailable",
        `Unable to index archive layer '${descriptor.rootUri}'.`
      );
    }
    const revision = createStableResourceProjectRevision("archive-revision", {
      sourceSignature: initialSignature,
      byteLength: bytes.byteLength
    });
    const authority = `${baseId}-${revision}`.toLowerCase();
    const rootUri = `${readOnlyArchiveResourceScheme}://${authority}/`;
    const mount: StoredMount = {
      baseId,
      sourceIdentity,
      sourceSignature: initialSignature,
      source: descriptor.source,
      sourceUri: descriptor.rootUri,
      layerId: descriptor.layerId,
      rootUri,
      revision,
      archive
    };
    const previous = this.currentByBaseId.get(baseId);
    if (previous) {
      this.mountsByAuthority.delete(resourceAuthority(previous.rootUri));
    }
    this.currentByBaseId.set(baseId, mount);
    this.mountsByAuthority.set(authority, mount);
    const event = publicMount(mount);
    for (const listener of this.mountListeners) {
      listener(event);
    }
    return event;
  }

  private resolveResourceUri(uri: SerializedResourceUri): {
    mount: StoredMount;
    entryPath: string;
  } {
    this.assertActive();
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new ArchiveResourceStoreError("invalidResourceUri", `Invalid archive resource URI: ${uri}`);
    }
    if (
      url.protocol !== `${readOnlyArchiveResourceScheme}:`
      || !url.hostname
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) {
      throw new ArchiveResourceStoreError("invalidResourceUri", `Invalid archive resource URI: ${uri}`);
    }
    const mount = this.mountsByAuthority.get(url.hostname.toLowerCase());
    if (!mount) {
      throw new ArchiveResourceStoreError("staleResourceUri", `Archive resource URI is stale: ${uri}`);
    }
    let entryPath: string;
    try {
      entryPath = url.pathname
        .split("/")
        .filter(Boolean)
        .map(segment => decodeURIComponent(segment))
        .join("/");
    } catch {
      throw new ArchiveResourceStoreError("invalidResourceUri", `Invalid archive entry URI: ${uri}`);
    }
    return { mount, entryPath };
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ArchiveResourceStoreError("sourceUnavailable", "Archive resource store is disposed.");
    }
  }
}

function publicMount(mount: StoredMount): ReadOnlyArchiveMount {
  return {
    layerId: mount.layerId,
    source: mount.source,
    sourceUri: mount.sourceUri,
    rootUri: mount.rootUri,
    revision: mount.revision
  };
}

function sameSourceStat(left: ArchiveResourceSourceStat, right: ArchiveResourceSourceStat): boolean {
  return left.type === right.type
    && left.ctime === right.ctime
    && left.mtime === right.mtime
    && left.size === right.size;
}

function resourceAuthority(uri: SerializedResourceUri): string {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isArchiveLayerDescriptor(
  descriptor: ResourceLayerDescriptor
): descriptor is ResourceLayerDescriptor & { source: "zip" | "clientJar" } {
  return descriptor.source === "zip" || descriptor.source === "clientJar";
}
