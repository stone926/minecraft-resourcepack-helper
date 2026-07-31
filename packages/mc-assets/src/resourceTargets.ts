import type { MinecraftResourceId } from "./resourceId";

export interface MinecraftResourceTarget {
  directory: string;
  extension: string | null;
  isDirectory: boolean;
}

export interface MinecraftResourceKindDescriptor extends MinecraftResourceTarget {
  /** Canonical camelCase kind used across the extension and RSGL. */
  kind: string;
  /** snake_case spelling accepted as an input alias for the canonical kind. */
  alias?: string;
  /** Reference-layer kind this resource resolves as (shader variants collapse to "shader"). */
  referenceKind?: string;
  /** Editor icon family; kinds without one present as generic objects. */
  iconCategory?: "code" | "media";
}

/**
 * Single source of truth for kind ↔ assets directory ↔ file extension.
 * Forward lookups (minecraftResourceTarget/minecraftResourceDirectory),
 * reverse assets-path inference (inferMinecraftResourceKindFromDirectory),
 * kind alias canonicalization, reference-kind collapsing, and icon
 * categories are all derived from this table.
 */
export const minecraftResourceKindDescriptors: readonly MinecraftResourceKindDescriptor[] = [
  { kind: "model", directory: "models", extension: "json", isDirectory: false, referenceKind: "model", iconCategory: "code" },
  { kind: "blockstate", directory: "blockstates", extension: "json", isDirectory: false, iconCategory: "code" },
  { kind: "item", directory: "items", extension: "json", isDirectory: false, iconCategory: "code" },
  { kind: "texture", directory: "textures", extension: "png", isDirectory: false, referenceKind: "texture", iconCategory: "media" },
  { kind: "textureDirectory", alias: "texture_directory", directory: "textures", extension: null, isDirectory: true, referenceKind: "textureDirectory" },
  { kind: "font", directory: "font", extension: "json", isDirectory: false, referenceKind: "font", iconCategory: "code" },
  { kind: "fontFile", alias: "font_file", directory: "font", extension: null, isDirectory: false, referenceKind: "fontFile" },
  { kind: "shaderVertex", alias: "shader_vertex", directory: "shaders", extension: "vsh", isDirectory: false, referenceKind: "shader" },
  { kind: "shaderFragment", alias: "shader_fragment", directory: "shaders", extension: "fsh", isDirectory: false, referenceKind: "shader" },
  { kind: "sound", directory: "sounds", extension: "ogg", isDirectory: false, referenceKind: "sound", iconCategory: "media" },
  { kind: "atlas", directory: "atlases", extension: "json", isDirectory: false },
  { kind: "particles", directory: "particles", extension: "json", isDirectory: false },
  { kind: "equipment", directory: "equipment", extension: "json", isDirectory: false },
  { kind: "waypoint_style", directory: "waypoint_style", extension: "json", isDirectory: false },
  { kind: "post_effect", directory: "post_effect", extension: "json", isDirectory: false },
  { kind: "lang", directory: "lang", extension: "json", isDirectory: false }
];

const descriptorByKind = new Map(minecraftResourceKindDescriptors.map(descriptor => [descriptor.kind, descriptor]));

const kindByAlias = new Map(minecraftResourceKindDescriptors
  .flatMap(descriptor => descriptor.alias ? [[descriptor.alias, descriptor.kind] as const] : []));

/** Extension-bearing file kinds grouped by assets directory, in table order. */
const inferableDescriptorsByDirectory = new Map<string, MinecraftResourceKindDescriptor[]>();
for (const descriptor of minecraftResourceKindDescriptors) {
  if (descriptor.isDirectory || descriptor.extension === null) {
    continue;
  }
  const bucket = inferableDescriptorsByDirectory.get(descriptor.directory) ?? [];
  bucket.push(descriptor);
  inferableDescriptorsByDirectory.set(descriptor.directory, bucket);
}

/** Maps snake_case alias spellings to canonical kinds; other values pass through. */
export function canonicalMinecraftResourceKind(kind: string): string {
  return kindByAlias.get(kind) ?? kind;
}

export function minecraftResourceDirectory(kind: string): string {
  return descriptorByKind.get(kind)?.directory ?? kind;
}

export function minecraftResourceTarget(kind: string): MinecraftResourceTarget {
  const descriptor = descriptorByKind.get(kind);
  return descriptor
    ? { directory: descriptor.directory, extension: descriptor.extension, isDirectory: descriptor.isDirectory }
    : { directory: kind, extension: "json", isDirectory: false };
}

export interface InferredMinecraftResourceKind {
  kind: string;
  extension: string;
}

/** Infers the kind of a file at `assets/<ns>/<directory>/<resourcePath>` when unambiguous. */
export function inferMinecraftResourceKindFromDirectory(
  directory: string,
  resourcePath: string
): InferredMinecraftResourceKind | null {
  for (const descriptor of inferableDescriptorsByDirectory.get(directory) ?? []) {
    if (descriptor.extension !== null && resourcePath.endsWith(`.${descriptor.extension}`)) {
      return { kind: descriptor.kind, extension: descriptor.extension };
    }
  }
  return null;
}

export function minecraftResourceOutputPath(kind: string, id: MinecraftResourceId, extension = "json"): string {
  return `assets/${id.namespace}/${minecraftResourceDirectory(kind)}/${id.path}.${extension}`;
}

/** Reference-layer kind for a resource kind, or null when it is not referenceable. */
export function minecraftReferenceKindForResourceKind(kind: string): string | null {
  return descriptorByKind.get(kind)?.referenceKind ?? null;
}

export type MinecraftResourceIconCategory = "code" | "media" | "object";

export function minecraftResourceKindIconCategory(kind: string): MinecraftResourceIconCategory {
  return descriptorByKind.get(kind)?.iconCategory ?? "object";
}

const iconCategoryByExtension = new Map(minecraftResourceKindDescriptors
  .flatMap(descriptor => descriptor.extension && descriptor.iconCategory
    ? [[descriptor.extension, descriptor.iconCategory] as const]
    : []));

/** Icon family for a bare file extension (no dot), derived from the kind table. */
export function minecraftResourceExtensionIconCategory(
  extension: string
): MinecraftResourceIconCategory | undefined {
  return iconCategoryByExtension.get(extension.toLowerCase());
}

/**
 * Extensions that hold text in a resource pack (openable in a text editor).
 * Physical scanning applies a narrower indexing subset locally.
 */
export const textResourceFileExtensions: ReadonlySet<string> = new Set([
  "json",
  "mcmeta",
  "properties",
  "rsgl",
  "vsh",
  "fsh",
  "glsl",
  "txt",
  "lang"
]);

export function isTextResourcePath(value: string): boolean {
  const dot = value.lastIndexOf(".");
  return dot >= 0 && textResourceFileExtensions.has(value.slice(dot + 1).toLowerCase());
}
