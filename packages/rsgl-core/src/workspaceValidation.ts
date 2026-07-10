import * as fs from "node:fs";
import * as path from "node:path";
import type {
  JsonValue,
  ResourceId,
  RsglBlockstateSchema,
  RsglResourceContentKind,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions,
  RsglSoundMetadata,
  RsglTextureMetadata
} from "./compiler";
import { inferBlockstateSchemaFromContent, parseResourceId } from "./compiler";
import type { ExternResourceSource } from "./externDeclarations";
import {
  findPackRoot,
  getConfiguredPackResourceRootCandidates,
  getDocumentResourceRootCandidates,
  getResourceRootCandidates,
  minecraftResourceTarget,
  readOggFileMetadata,
  readPackMetadata,
  readPngFileMetadata,
  type MinecraftResourceTarget,
  type PackMetadata
} from "../../mc-assets/src";

export interface RsglWorkspaceValidationOptions {
  sourceFileName: string;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  fileSystem?: RsglValidationFileSystem;
}

export interface RsglValidationFileSystem {
  exists(fileName: string): boolean;
  isDirectory(fileName: string): boolean;
  readJson(fileName: string): JsonValue | null;
  readPngMetadata(fileName: string): RsglTextureMetadata | null;
  readOggMetadata(fileName: string): RsglSoundMetadata | null;
}

export interface RsglWorkspaceValidationCallbacks extends Pick<
  RsglResourceValidationOptions,
  "resourceExists" | "resourceContent" | "textureMetadata" | "soundMetadata" | "blockstateSchema"
> {
  externResourceExists(source: ExternResourceSource, kind: RsglResourceExistenceKind, id: string): boolean;
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
  readOggMetadata: fileName => readOggFileMetadata(fileName)
};

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
    externResourcePath: (source, kind, id) => resolver.resolve(id, minecraftResourceTarget(kind), source),
    externResourceContent: (source, kind, id) => resolver.readJson(id, minecraftResourceTarget(kind), source),
    externTextureMetadata: (source, id) => resolver.textureMetadata(id, source),
    externSoundMetadata: (source, id) => resolver.soundMetadata(id, source),
    externBlockstateSchema: (source, id) => resolver.blockstateSchema(id, source)
  };
}

class WorkspaceResourceResolver {
  private readonly fileSystem: RsglValidationFileSystem;
  private readonly sourceFileName: string;
  private readonly defaultAssetsPath: string | null;
  private readonly resourcePackRoots: string[];
  private readonly resolvedPaths = new Map<string, string | null>();
  private readonly packMetadataByRoot = new Map<string, PackMetadata>();
  private packRoot: string | null | undefined;

  constructor(options: RsglWorkspaceValidationOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.sourceFileName = path.resolve(options.sourceFileName);
    this.defaultAssetsPath = options.defaultAssetsPath ?? null;
    this.resourcePackRoots = options.resourcePackRoots ?? [];
  }

  resolve(id: string, target: MinecraftResourceTarget, source?: ExternResourceSource): string | null {
    const cacheKey = `${source ?? "workspace"}\0${target.directory}\0${target.extension ?? ""}\0${target.isDirectory ? "d" : "f"}\0${id}`;
    const cached = this.resolvedPaths.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = this.resolveUncached(id, target, source);
    this.resolvedPaths.set(cacheKey, resolved);
    return resolved;
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

  private resolveUncached(id: string, target: MinecraftResourceTarget, source?: ExternResourceSource): string | null {
    const resourceId = parseResourceId(id, "minecraft");
    if (!resourceId) {
      return null;
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

    for (const root of roots) {
      const candidate = path.join(root, ...relativePath);
      if (target.isDirectory ? this.fileSystem.isDirectory(candidate) : this.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
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

    return getConfiguredPackResourceRootCandidates(
      this.resourcePackRoots,
      resourceId.namespace,
      target.directory,
      {
        pathExists: fileName => this.fileSystem.exists(fileName),
        getPackMetadata: packRoot => this.getPackMetadata(packRoot),
        resourcePath: path.posix.join(target.directory.replaceAll("\\", "/"), resourcePath),
        excludedPackRoot: this.getPackRoot(this.sourceFileName)
      }
    );
  }

  private getPackRoot(fileName: string): string | null {
    if (this.packRoot === undefined) {
      this.packRoot = findPackRoot(fileName, { pathExists: candidate => this.fileSystem.exists(candidate) });
    }
    return this.packRoot;
  }

  private getPackMetadata(packRoot: string): PackMetadata {
    let metadata = this.packMetadataByRoot.get(packRoot);
    if (!metadata) {
      metadata = readPackMetadata(packRoot, { pathExists: candidate => this.fileSystem.exists(candidate) });
      this.packMetadataByRoot.set(packRoot, metadata);
    }
    return metadata;
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
