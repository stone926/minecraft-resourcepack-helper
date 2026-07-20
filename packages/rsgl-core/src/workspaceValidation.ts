import * as fs from "node:fs";
import * as path from "node:path";
import type {
  JsonValue,
  ResourceId,
  RsglBlockstateSchema,
  RsglExternalResourceResolution,
  RsglResourceContentKind,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  RsglSoundMetadata,
  RsglTextureMetadata
} from "./compiler";
import { inferBlockstateSchemaFromContent, parseResourceId } from "./compiler";
import type { ExternResourceSource } from "./externDeclarations";
import { BoundedCache } from "./boundedCache";
import {
  findPackRoot,
  getConfiguredPackResourceRootCandidates,
  getDocumentResourceRootCandidates,
  getResourceRootCandidates,
  minecraftResourceTarget,
  normalizePathKey,
  readOggFileMetadata,
  readPackMetadata,
  readPngFileMetadata,
  type MinecraftResourceTarget,
  type PackMetadata
} from "../../mc-assets/src";

export interface RsglWorkspaceValidationOptions {
  sourceFileName: string;
  /** Canonical target resource-pack root. `local` never infers this from the source file. */
  outputPackRoot?: string | null;
  /**
   * Materialized paths owned by RSGL projects. Local lookup keeps these paths
   * as candidates, but cannot resolve them as handwritten resources.
   */
  excludedLocalResourcePaths?: readonly string[];
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  fileSystem?: RsglValidationFileSystem;
  cache?: RsglWorkspaceValidationCache;
}

export interface RsglValidationFileSystem {
  exists(fileName: string): boolean;
  isDirectory(fileName: string): boolean;
  readJson(fileName: string): JsonValue | null;
  readPngMetadata(fileName: string): RsglTextureMetadata | null;
  readOggMetadata(fileName: string): RsglSoundMetadata | null;
  fileVersion?(fileName: string): string | null;
}

export interface RsglWorkspaceValidationCacheOptions {
  fileSystem?: RsglValidationFileSystem;
  watcherTrusted?: boolean;
  verificationTtlMs?: number;
  clock?: () => number;
}

interface CachedValidationValue<T> {
  readonly value: T;
  readonly version?: string | null;
  verifiedAt: number;
}

type RequiredResourceValidationCallbacks = Required<Pick<
  RsglResourceValidationOptions,
  "resourceExists" | "resourceContent" | "textureMetadata" | "soundMetadata" | "blockstateSchema"
>>;

export interface RsglWorkspaceValidationCallbacks extends RequiredResourceValidationCallbacks {
  externResourceExists(source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string): boolean;
  externResourceResolution(
    source: ExternResourceSource,
    kind: RsglResourceExistenceKind,
    id: string
  ): RsglExternalResourceResolution;
  externResourcePath(source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string): string | null;
  externResourceContent(source: ExternResourceSource, kind: RsglResourceContentKind, id: string): JsonValue | null;
  externTextureMetadata(source: ExternResourceSource, id: string): RsglTextureMetadata | null | undefined;
  externSoundMetadata(source: ExternResourceSource, id: string): RsglSoundMetadata | null | undefined;
  externBlockstateSchema(source: ExternResourceSource, id: ResourceId): RsglBlockstateSchema | null;
}

const defaultFileSystem: RsglValidationFileSystem = {
  exists: fileName => fileExists(fileName),
  isDirectory: fileName => directoryExists(fileName),
  readJson: fileName => readJsonFile(fileName),
  readPngMetadata: fileName => readPngFileMetadata(fileName),
  readOggMetadata: fileName => readOggFileMetadata(fileName),
  fileVersion: fileName => fileVersion(fileName)
};

/**
 * Shared validation I/O cache for repeated LSP compiles.
 *
 * Watcher-backed hosts reuse hot values without filesystem calls and explicitly
 * invalidate changed paths. Other hosts verify file-backed values by TTL and
 * mtime/size before reading them again.
 */
export class RsglWorkspaceValidationCache implements RsglValidationFileSystem {
  private readonly fileSystem: RsglValidationFileSystem;
  private readonly watcherTrusted: boolean;
  private readonly verificationTtlMs: number;
  private readonly clock: () => number;
  private readonly existence = new BoundedCache<string, CachedValidationValue<boolean>>(8_192);
  private readonly directories = new BoundedCache<string, CachedValidationValue<boolean>>(2_048);
  private readonly json = new BoundedCache<string, CachedValidationValue<JsonValue | null>>(2_048);
  private readonly png = new BoundedCache<string, CachedValidationValue<RsglTextureMetadata | null>>(2_048);
  private readonly ogg = new BoundedCache<string, CachedValidationValue<RsglSoundMetadata | null>>(2_048);
  private readonly packMetadata = new BoundedCache<string, CachedValidationValue<PackMetadata>>(256);
  private cacheGeneration = 0;

  public constructor(options: RsglWorkspaceValidationCacheOptions = {}) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.watcherTrusted = options.watcherTrusted ?? false;
    this.verificationTtlMs = normalizeVerificationTtl(options.verificationTtlMs);
    this.clock = options.clock ?? Date.now;
  }

  public get generation(): number {
    return this.cacheGeneration;
  }

  public exists(fileName: string): boolean {
    return this.getQueryValue(this.existence, fileName, () => this.fileSystem.exists(fileName));
  }

  public isDirectory(fileName: string): boolean {
    return this.getQueryValue(this.directories, fileName, () => this.fileSystem.isDirectory(fileName));
  }

  public readJson(fileName: string): JsonValue | null {
    return this.getFileValue(this.json, fileName, () => this.fileSystem.readJson(fileName));
  }

  public readPngMetadata(fileName: string): RsglTextureMetadata | null {
    return this.getFileValue(this.png, fileName, () => this.fileSystem.readPngMetadata(fileName));
  }

  public readOggMetadata(fileName: string): RsglSoundMetadata | null {
    return this.getFileValue(this.ogg, fileName, () => this.fileSystem.readOggMetadata(fileName));
  }

  public fileVersion(fileName: string): string | null {
    return this.fileSystem.fileVersion?.(fileName) ?? null;
  }

  public readPackMetadata(packRoot: string): PackMetadata {
    const mcmetaPath = path.join(packRoot, "pack.mcmeta");
    return this.getFileValue(this.packMetadata, mcmetaPath, () =>
      readPackMetadata(packRoot, { pathExists: candidate => this.exists(candidate) }));
  }

  public invalidatePath(fileName: string): void {
    const key = normalizePathKey(fileName);
    this.cacheGeneration++;
    this.existence.delete(key);
    this.directories.delete(key);
    this.json.delete(key);
    this.png.delete(key);
    this.ogg.delete(key);
    this.packMetadata.delete(key);
  }

  public invalidateAll(): void {
    this.cacheGeneration++;
    this.existence.clear();
    this.directories.clear();
    this.json.clear();
    this.png.clear();
    this.ogg.clear();
    this.packMetadata.clear();
  }

  private getQueryValue<T>(
    cache: BoundedCache<string, CachedValidationValue<T>>,
    fileName: string,
    compute: () => T
  ): T {
    const key = normalizePathKey(fileName);
    const now = this.clock();
    const cached = cache.get(key);
    if (cached && this.canReuse(cached, now)) {
      return cached.value;
    }
    const value = compute();
    cache.set(key, { value, verifiedAt: now });
    return value;
  }

  private getFileValue<T>(
    cache: BoundedCache<string, CachedValidationValue<T>>,
    fileName: string,
    compute: () => T
  ): T {
    const key = normalizePathKey(fileName);
    const now = this.clock();
    const cached = cache.get(key);
    if (cached && this.canReuse(cached, now)) {
      return cached.value;
    }

    const version = this.fileSystem.fileVersion?.(fileName);
    if (cached && version !== undefined && cached.version === version) {
      cached.verifiedAt = now;
      return cached.value;
    }

    const value = compute();
    cache.set(key, { value, version, verifiedAt: now });
    return value;
  }

  private canReuse(entry: CachedValidationValue<unknown>, now: number): boolean {
    return this.watcherTrusted
      || (now >= entry.verifiedAt && now - entry.verifiedAt < this.verificationTtlMs);
  }
}

export function createRsglWorkspaceValidationOptions(
  options: RsglWorkspaceValidationOptions
): RsglWorkspaceValidationCallbacks {
  const resolver = new WorkspaceResourceResolver(options);
  return {
    resourceExists: (kind, id) => resolver.resolve(id, minecraftResourceTarget(kind)) !== null,
    resourceContent: (kind, id) => resolver.readJson(id, minecraftResourceTarget(kind)),
    textureMetadata: id => resolver.textureMetadata(id),
    soundMetadata: id => resolver.soundMetadata(id),
    blockstateSchema: id => resolver.blockstateSchema(id),
    externResourceExists: (source, kind, id) => resolver.resolve(id, minecraftResourceTarget(kind), source) !== null,
    externResourceResolution: (source, kind, id) =>
      resolver.resolveWithCandidates(id, minecraftResourceTarget(kind), source),
    externResourcePath: (source, kind, id) => resolver.resolve(id, minecraftResourceTarget(kind), source),
    externResourceContent: (source, kind, id) => resolver.readJson(id, minecraftResourceTarget(kind), source),
    externTextureMetadata: (source, id) => resolver.textureMetadata(id, source),
    externSoundMetadata: (source, id) => resolver.soundMetadata(id, source),
    externBlockstateSchema: (source, id) => resolver.blockstateSchema(id, source)
  };
}

class WorkspaceResourceResolver {
  private readonly fileSystem: RsglValidationFileSystem;
  private readonly validationCache: RsglWorkspaceValidationCache;
  private readonly sourceFileName: string;
  private readonly outputPackRoot: string | null;
  private readonly excludedLocalResourcePathKeys: ReadonlySet<string>;
  private readonly defaultAssetsPath: string | null;
  private readonly resourcePackRoots: string[];

  constructor(options: RsglWorkspaceValidationOptions) {
    this.validationCache = options.cache ?? new RsglWorkspaceValidationCache({
      fileSystem: options.fileSystem
    });
    this.fileSystem = this.validationCache;
    this.sourceFileName = path.resolve(options.sourceFileName);
    this.outputPackRoot = options.outputPackRoot ? path.resolve(options.outputPackRoot) : null;
    this.excludedLocalResourcePathKeys = new Set(
      (options.excludedLocalResourcePaths ?? []).map(fileName => normalizePathKey(path.resolve(fileName)))
    );
    this.defaultAssetsPath = options.defaultAssetsPath ?? null;
    this.resourcePackRoots = options.resourcePackRoots ?? [];
  }

  resolve(id: string, target: MinecraftResourceTarget, source?: ExternResourceSource): string | null {
    return this.resolveWithCandidates(id, target, source).resolvedPath;
  }

  resolveWithCandidates(
    id: string,
    target: MinecraftResourceTarget,
    source?: ExternResourceSource
  ): RsglExternalResourceResolution {
    return this.resolveUncached(id, target, source);
  }

  readJson(id: string, target: MinecraftResourceTarget, source?: ExternResourceSource): JsonValue | null {
    const fileName = this.resolve(id, target, source);
    return fileName ? this.fileSystem.readJson(fileName) : null;
  }

  textureMetadata(id: string, source?: ExternResourceSource): RsglTextureMetadata | null | undefined {
    const fileName = this.resolve(id, minecraftResourceTarget("texture"), source);
    return fileName ? this.fileSystem.readPngMetadata(fileName) : undefined;
  }

  soundMetadata(id: string, source?: ExternResourceSource): RsglSoundMetadata | null | undefined {
    const fileName = this.resolve(id, minecraftResourceTarget("sound"), source);
    return fileName ? this.fileSystem.readOggMetadata(fileName) : undefined;
  }

  blockstateSchema(id: ResourceId, source?: ExternResourceSource): RsglBlockstateSchema | null {
    const content = this.readJson(`${id.namespace}:${id.path}`, minecraftResourceTarget("blockstate"), source);
    return inferBlockstateSchemaFromContent(content ?? undefined);
  }

  private resolveUncached(
    id: string,
    target: MinecraftResourceTarget,
    source?: ExternResourceSource
  ): RsglExternalResourceResolution {
    const resourceId = parseResourceId(id, "minecraft");
    if (!resourceId) {
      return { resolvedPath: null, candidatePaths: [] };
    }

    const resourcePath = resourcePathWithTargetExtension(resourceId.path, target);
    const relativePath = resourcePath.split("/");
    const roots = source
      ? this.getExternResourceRootCandidates(source, resourceId, target, resourcePath)
      : getDocumentResourceRootCandidates(
        this.sourceFileName,
        target.directory,
        this.defaultAssetsPath,
        resourceId.namespace,
        target.directory,
        {
          pathExists: fileName => this.fileSystem.exists(fileName),
          getPackRoot: fileName => this.getPackRoot(fileName),
          getPackMetadata: packRoot => this.getPackMetadata(packRoot),
          resourcePath,
          resourcePackRoots: this.resourcePackRoots
        }
      );

    const candidatePaths = roots.map(root => path.join(root, ...relativePath));
    for (const candidate of candidatePaths) {
      if (
        source === "local"
        && this.isLocalResourcePathExcluded(candidate, target.isDirectory)
      ) {
        continue;
      }
      if (target.isDirectory ? this.fileSystem.isDirectory(candidate) : this.fileSystem.exists(candidate)) {
        return {
          resolvedPath: candidate,
          candidatePaths,
          metadataPaths: this.packMetadataDependencyPaths()
        };
      }
    }
    return {
      resolvedPath: null,
      candidatePaths,
      metadataPaths: this.packMetadataDependencyPaths()
    };
  }

  private getExternResourceRootCandidates(
    source: ExternResourceSource,
    resourceId: ResourceId,
    target: MinecraftResourceTarget,
    resourcePath: string
  ): string[] {
    if (source === "vanilla") {
      return getResourceRootCandidates(null, this.defaultAssetsPath, resourceId.namespace, target.directory);
    }

    if (source === "local") {
      return this.outputPackRoot
        ? getConfiguredPackResourceRootCandidates(
          [this.outputPackRoot],
          resourceId.namespace,
          target.directory,
          {
            pathExists: fileName => this.fileSystem.exists(fileName),
            getPackMetadata: packRoot => this.getPackMetadata(packRoot),
            resourcePath: path.posix.join(target.directory.replaceAll("\\", "/"), resourcePath)
          }
        )
        : [];
    }

    return getConfiguredPackResourceRootCandidates(
      this.resourcePackRoots,
      resourceId.namespace,
      target.directory,
      {
        pathExists: fileName => this.fileSystem.exists(fileName),
        getPackMetadata: packRoot => this.getPackMetadata(packRoot),
        resourcePath: path.posix.join(target.directory.replaceAll("\\", "/"), resourcePath),
        excludedPackRoot: this.outputPackRoot ?? this.getPackRoot(this.sourceFileName)
      }
    );
  }

  private getPackRoot(fileName: string): string | null {
    return findPackRoot(fileName, { pathExists: candidate => this.fileSystem.exists(candidate) });
  }

  private isLocalResourcePathExcluded(fileName: string, directory: boolean): boolean {
    const candidateKey = normalizePathKey(fileName);
    if (this.excludedLocalResourcePathKeys.has(candidateKey)) {
      return true;
    }
    if (!directory) {
      return false;
    }
    const prefix = candidateKey.endsWith(path.sep) ? candidateKey : `${candidateKey}${path.sep}`;
    return [...this.excludedLocalResourcePathKeys].some(excludedPath => excludedPath.startsWith(prefix));
  }

  private getPackMetadata(packRoot: string): PackMetadata {
    return this.validationCache.readPackMetadata(packRoot);
  }

  private packMetadataDependencyPaths(): string[] {
    const paths = new Map<string, string>();
    const addPackRoot = (packRoot: string | null): void => {
      if (!packRoot) {
        return;
      }
      const metadataPath = path.join(path.resolve(packRoot), "pack.mcmeta");
      paths.set(normalizePathKey(metadataPath), metadataPath);
    };

    const existingSourcePackRoot = this.getPackRoot(this.sourceFileName);
    const existingSourcePackKey = existingSourcePackRoot
      ? normalizePathKey(existingSourcePackRoot)
      : null;
    let sourceAncestor = path.dirname(this.sourceFileName);
    while (true) {
      addPackRoot(sourceAncestor);
      if (existingSourcePackKey === normalizePathKey(sourceAncestor)) {
        break;
      }
      const parent = path.dirname(sourceAncestor);
      if (parent === sourceAncestor) {
        break;
      }
      sourceAncestor = parent;
    }
    for (const configuredRoot of this.resourcePackRoots) {
      addPackRoot(configuredRoot);
    }
    addPackRoot(this.outputPackRoot);
    return [...paths.values()];
  }
}

function resourcePathWithTargetExtension(resourcePath: string, target: MinecraftResourceTarget): string {
  const extension = target.extension ? `.${target.extension}` : "";
  return extension && !resourcePath.endsWith(extension)
    ? `${resourcePath}${extension}`
    : resourcePath;
}

function readJsonFile(fileName: string): JsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

function fileExists(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isFile();
  } catch {
    return false;
  }
}

function directoryExists(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}

function fileVersion(fileName: string): string | null {
  try {
    const stat = fs.statSync(fileName);
    return `${stat.mtimeMs}:${stat.size}:${stat.isDirectory() ? "d" : "f"}`;
  } catch {
    return null;
  }
}

const DEFAULT_VERIFICATION_TTL_MS = 1_000;

function normalizeVerificationTtl(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : DEFAULT_VERIFICATION_TTL_MS;
}
