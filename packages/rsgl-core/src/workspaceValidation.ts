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

type ResourceTarget = {
  target: string;
  extension: string | null;
  directory: boolean;
};

const defaultFileSystem: RsglValidationFileSystem = {
  exists: fileName => pathExists(fileName),
  isDirectory: fileName => directoryExists(fileName),
  readJson: fileName => readJsonFile(fileName),
  readPngMetadata: fileName => readPngMetadata(fileName),
  readOggMetadata: fileName => readOggMetadata(fileName)
};

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createRsglWorkspaceValidationOptions(
  options: RsglWorkspaceValidationOptions
): Pick<RsglResourceValidationOptions, "resourceExists" | "resourceContent" | "textureMetadata" | "soundMetadata" | "blockstateSchema"> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  return {
    resourceExists: (kind, id) => resourceExists(fileSystem, options, kind, id),
    resourceContent: (kind, id) => resourceContent(fileSystem, options, kind, id),
    textureMetadata: id => textureMetadata(fileSystem, options, id),
    soundMetadata: id => soundMetadata(fileSystem, options, id),
    blockstateSchema: id => blockstateSchema(fileSystem, options, id)
  };
}

function resourceExists(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  kind: RsglResourceExistenceKind,
  id: string
): boolean {
  const target = resourceTarget(kind);
  const fileName = resolveResource(fileSystem, options, id, target);
  if (!fileName) {
    return false;
  }
  return target.directory ? fileSystem.isDirectory(fileName) : fileSystem.exists(fileName);
}

function resourceContent(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  kind: RsglResourceContentKind,
  id: string
): JsonValue | null {
  const fileName = resolveResource(fileSystem, options, id, resourceTarget(kind));
  return fileName ? fileSystem.readJson(fileName) : null;
}

function textureMetadata(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  id: string
): RsglTextureMetadata | null | undefined {
  const fileName = resolveResource(fileSystem, options, id, resourceTarget("texture"));
  return fileName ? fileSystem.readPngMetadata(fileName) : undefined;
}

function soundMetadata(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  id: string
): RsglSoundMetadata | null | undefined {
  const fileName = resolveResource(fileSystem, options, id, resourceTarget("sound"));
  return fileName ? fileSystem.readOggMetadata(fileName) : undefined;
}

function blockstateSchema(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  id: ResourceId
): RsglBlockstateSchema | null {
  const fileName = resolveResource(fileSystem, options, `${id.namespace}:${id.path}`, {
    target: "blockstates",
    extension: "json",
    directory: false
  });
  return inferBlockstateSchemaFromContent(fileName ? fileSystem.readJson(fileName) ?? undefined : undefined);
}

function resolveResource(
  fileSystem: RsglValidationFileSystem,
  options: RsglWorkspaceValidationOptions,
  id: string,
  target: ResourceTarget
): string | null {
  const resourceId = parseResourceId(id, "minecraft");
  if (!resourceId) {
    return null;
  }

  for (const candidate of resourceCandidates(options, resourceId, target)) {
    if (target.directory ? fileSystem.isDirectory(candidate) : fileSystem.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resourceCandidates(
  options: RsglWorkspaceValidationOptions,
  id: ResourceId,
  target: ResourceTarget
): string[] {
  const candidates: string[] = [];
  for (const packRoot of resourcePackRoots(options)) {
    candidates.push(resourcePathInPackRoot(packRoot, id, target));
  }

  if (options.defaultAssetsPath) {
    candidates.push(...resourcePathsInDefaultAssetsPath(options.defaultAssetsPath, id, target));
  }
  return uniqueNormalizedPaths(candidates);
}

function resourcePackRoots(options: RsglWorkspaceValidationOptions): string[] {
  const roots: string[] = [];
  const nearestPackRoot = findNearestPackRoot(path.dirname(path.resolve(options.sourceFileName)));
  if (nearestPackRoot) {
    roots.push(nearestPackRoot);
  }
  roots.push(...(options.resourcePackRoots ?? []));
  return roots;
}

function resourcePathInPackRoot(packRoot: string, id: ResourceId, target: ResourceTarget): string {
  return withExtension(path.join(packRoot, "assets", id.namespace, target.target, id.path), target.extension);
}

function resourcePathsInDefaultAssetsPath(defaultAssetsPath: string, id: ResourceId, target: ResourceTarget): string[] {
  const root = path.resolve(defaultAssetsPath);
  return [
    withExtension(path.join(root, "assets", id.namespace, target.target, id.path), target.extension),
    withExtension(path.join(root, id.namespace, target.target, id.path), target.extension),
    withExtension(path.join(root, target.target, id.path), target.extension)
  ];
}

function withExtension(fileName: string, extension: string | null): string {
  return extension ? `${fileName}.${extension}` : fileName;
}

function findNearestPackRoot(startDirectory: string): string | null {
  let directory = path.resolve(startDirectory);
  while (true) {
    if (pathExists(path.join(directory, "pack.mcmeta"))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function resourceTarget(kind: RsglResourceExistenceKind | RsglResourceContentKind): ResourceTarget {
  if (kind === "model") {
    return { target: "models", extension: "json", directory: false };
  }
  if (kind === "blockstate") {
    return { target: "blockstates", extension: "json", directory: false };
  }
  if (kind === "item") {
    return { target: "items", extension: "json", directory: false };
  }
  if (kind === "textureDirectory") {
    return { target: "textures", extension: null, directory: true };
  }
  if (kind === "texture") {
    return { target: "textures", extension: "png", directory: false };
  }
  if (kind === "font") {
    return { target: "font", extension: "json", directory: false };
  }
  if (kind === "fontFile") {
    return { target: "font", extension: null, directory: false };
  }
  if (kind === "shaderVertex") {
    return { target: "shaders", extension: "vsh", directory: false };
  }
  if (kind === "shaderFragment") {
    return { target: "shaders", extension: "fsh", directory: false };
  }
  return { target: "sounds", extension: "ogg", directory: false };
}

function readJsonFile(fileName: string): JsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

function readPngMetadata(fileName: string): RsglTextureMetadata | null {
  try {
    const bytes = fs.readFileSync(fileName);
    if (bytes.length < 24 || !bytes.subarray(0, pngSignature.length).equals(pngSignature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      return null;
    }
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

function readOggMetadata(fileName: string): RsglSoundMetadata | null {
  try {
    const bytes = fs.readFileSync(fileName);
    let offset = 0;
    let firstPacket: Buffer | null = null;
    let currentPacket: Buffer[] = [];
    let lastGranule: bigint | null = null;

    while (offset + 27 <= bytes.length) {
      if (bytes.toString("ascii", offset, offset + 4) !== "OggS") {
        return null;
      }
      const pageSegments = bytes[offset + 26];
      const segmentTableOffset = offset + 27;
      const bodyOffset = segmentTableOffset + pageSegments;
      if (bodyOffset > bytes.length) {
        return null;
      }

      let bodyLength = 0;
      for (let index = 0; index < pageSegments; index++) {
        bodyLength += bytes[segmentTableOffset + index];
      }
      if (bodyOffset + bodyLength > bytes.length) {
        return null;
      }

      const granule = readOggGranulePosition(bytes, offset + 6);
      if (granule !== null) {
        lastGranule = granule;
      }

      let bodyCursor = bodyOffset;
      for (let index = 0; index < pageSegments; index++) {
        const segmentLength = bytes[segmentTableOffset + index];
        currentPacket.push(bytes.subarray(bodyCursor, bodyCursor + segmentLength));
        bodyCursor += segmentLength;
        if (segmentLength < 255) {
          firstPacket ??= Buffer.concat(currentPacket);
          currentPacket = [];
        }
      }

      offset = bodyOffset + bodyLength;
    }

    return firstPacket ? readVorbisIdentification(firstPacket, lastGranule) : null;
  } catch {
    return null;
  }
}

function readVorbisIdentification(packet: Buffer, lastGranule: bigint | null): RsglSoundMetadata | null {
  if (packet.length < 30 || packet[0] !== 1 || packet.toString("ascii", 1, 7) !== "vorbis") {
    return null;
  }
  const channels = packet[11];
  const sampleRate = packet.readUInt32LE(12);
  if (!Number.isInteger(channels) || channels <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const metadata: RsglSoundMetadata = {
    codec: "vorbis",
    channels,
    sampleRate
  };
  if (lastGranule !== null) {
    metadata.durationSeconds = Number(lastGranule) / sampleRate;
  }
  return metadata;
}

function readOggGranulePosition(bytes: Buffer, offset: number): bigint | null {
  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) + BigInt(bytes[offset + index]);
  }
  return value === 0xffffffffffffffffn ? null : value;
}

function pathExists(fileName: string): boolean {
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

function uniqueNormalizedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fileName of paths) {
    const normalized = path.normalize(fileName);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}
