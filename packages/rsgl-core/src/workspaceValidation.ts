import * as fs from "node:fs";
import * as path from "node:path";
import type {
  JsonValue,
  ResourceId,
  RsglBlockstateSchema,
  RsglResourceValidationOptions,
  RsglSoundMetadata,
  RsglTextureMetadata
} from "./compiler";
import { inferBlockstateSchemaFromContent, parseResourceId } from "./compiler";
import {
  findPackRoot,
  getDocumentResourceRootCandidates,
  minecraftResourceTarget,
  readOggMetadata,
  readPackMetadata,
  readPngMetadata,
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

const defaultFileSystem: RsglValidationFileSystem = {
  exists: fileName => fileExists(fileName),
  isDirectory: fileName => directoryExists(fileName),
  readJson: fileName => readJsonFile(fileName),
  readPngMetadata: fileName => readFileMetadata(fileName, readPngMetadata),
  readOggMetadata: fileName => readFileMetadata(fileName, readOggMetadata)
};

export function createRsglWorkspaceValidationOptions(
  options: RsglWorkspaceValidationOptions
): Pick<RsglResourceValidationOptions, "resourceExists" | "resourceContent" | "textureMetadata" | "soundMetadata" | "blockstateSchema"> {
  const resolver = new WorkspaceResourceResolver(options);
  return {
    resourceExists: (kind, id) => resolver.resolve(id, minecraftResourceTarget(kind)) !== null,
    resourceContent: (kind, id) => resolver.readJson(id, minecraftResourceTarget(kind)),
    textureMetadata: id => resolver.textureMetadata(id),
    soundMetadata: id => resolver.soundMetadata(id),
    blockstateSchema: id => resolver.blockstateSchema(id)
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

  resolve(id: string, target: MinecraftResourceTarget): string | null {
    const cacheKey = `${target.directory}\0${target.extension ?? ""}\0${target.isDirectory ? "d" : "f"}\0${id}`;
    const cached = this.resolvedPaths.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = this.resolveUncached(id, target);
    this.resolvedPaths.set(cacheKey, resolved);
    return resolved;
  }

  readJson(id: string, target: MinecraftResourceTarget): JsonValue | null {
    const fileName = this.resolve(id, target);
    return fileName ? this.fileSystem.readJson(fileName) : null;
  }

  textureMetadata(id: string): RsglTextureMetadata | null | undefined {
    const fileName = this.resolve(id, minecraftResourceTarget("texture"));
    return fileName ? this.fileSystem.readPngMetadata(fileName) : undefined;
  }

  soundMetadata(id: string): RsglSoundMetadata | null | undefined {
    const fileName = this.resolve(id, minecraftResourceTarget("sound"));
    return fileName ? this.fileSystem.readOggMetadata(fileName) : undefined;
  }

  blockstateSchema(id: ResourceId): RsglBlockstateSchema | null {
    const content = this.readJson(`${id.namespace}:${id.path}`, minecraftResourceTarget("blockstate"));
    return inferBlockstateSchemaFromContent(content ?? undefined);
  }

  private resolveUncached(id: string, target: MinecraftResourceTarget): string | null {
    const resourceId = parseResourceId(id, "minecraft");
    if (!resourceId) {
      return null;
    }

    const relativePath = resourceId.path.split("/");
    const extension = target.extension ? `.${target.extension}` : "";
    const roots = getDocumentResourceRootCandidates(
      this.sourceFileName,
      target.directory,
      this.defaultAssetsPath,
      resourceId.namespace,
      target.directory,
      {
        pathExists: fileName => this.fileSystem.exists(fileName),
        getPackRoot: fileName => this.getPackRoot(fileName),
        getPackMetadata: packRoot => this.getPackMetadata(packRoot),
        resourcePath: `${resourceId.path}${extension}`,
        resourcePackRoots: this.resourcePackRoots
      }
    );

    for (const root of roots) {
      const candidate = `${path.join(root, ...relativePath)}${extension}`;
      if (target.isDirectory ? this.fileSystem.isDirectory(candidate) : this.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
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

function readJsonFile(fileName: string): JsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

function readFileMetadata<T>(fileName: string, read: (bytes: Uint8Array) => T | null): T | null {
  try {
    return read(fs.readFileSync(fileName));
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
