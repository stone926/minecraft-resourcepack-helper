import {
  minecraftResourceIdToString,
  tryParseMinecraftResourceId,
  type MinecraftResourceId
} from "./resourceId";
import {
  canonicalMinecraftResourceKind,
  inferMinecraftResourceKindFromDirectory,
  minecraftResourceTarget
} from "./resourceTargets";

export interface ResourceGraphLogicalKey {
  kind: string;
  id: string;
}

export type ResourceGraphKeyCategory = "concrete" | "alias" | "aggregate";

export interface CanonicalResourceGraphIdentity {
  primaryKey: ResourceGraphLogicalKey;
  /** Aggregate targets are addressable keys but never concrete producers. */
  primaryCategory: Exclude<ResourceGraphKeyCategory, "alias">;
  aliasKeys: readonly ResourceGraphLogicalKey[];
  aggregateMemberships: readonly ResourceGraphLogicalKey[];
}

export interface CanonicalizeResourceGraphIdentityOptions {
  defaultNamespace?: string;
  /** Overrides the kind registry. Use null for extension-bearing resources such as font files. */
  extension?: string | null;
}

export interface CanonicalizeResourceGraphOutputPathOptions {
  /** Controls structural path matching only; logical Minecraft IDs must remain lowercase-valid. */
  fileSystemCaseSensitive?: boolean;
}

/**
 * Canonicalizes a typed Minecraft resource identity without consulting the
 * filesystem. Concrete producer identity, same-producer aliases, and aggregate
 * memberships are kept separate so consumers cannot accidentally rank them as
 * independent producers.
 */
export function canonicalizeResourceGraphIdentity(
  kind: string,
  value: string,
  options: CanonicalizeResourceGraphIdentityOptions = {}
): CanonicalResourceGraphIdentity | null {
  const normalizedKind = canonicalMinecraftResourceKind(kind);
  const initial = tryParseMinecraftResourceId(
    value.replaceAll("\\", "/"),
    options.defaultNamespace ?? "minecraft"
  );
  if (!initial) {
    return null;
  }

  const shaderKind = resolveShaderKind(normalizedKind, initial.path, options.extension);
  if (normalizedKind === "shader" && !shaderKind) {
    return null;
  }
  const primaryKind = shaderKind ?? normalizedKind;
  const extension = normalizeExtension(
    options.extension === undefined
      ? minecraftResourceTarget(primaryKind).extension
      : options.extension
  );
  const canonicalId = stripExpectedExtension(initial, extension);
  if (!canonicalId) {
    return null;
  }

  const primaryKey: ResourceGraphLogicalKey = {
    kind: primaryKind,
    id: minecraftResourceIdToString(canonicalId)
  };
  const aliasKeys = primaryKind === "texture"
    ? [{
      kind: primaryKind,
      id: minecraftResourceIdToString({
        namespace: canonicalId.namespace,
        path: `${canonicalId.path}.png`
      })
    }]
    : [];
  const aggregateMemberships = primaryKind === "texture"
    ? textureDirectoryMemberships(canonicalId)
    : [];

  return {
    primaryKey,
    primaryCategory: primaryKind === "textureDirectory" ? "aggregate" : "concrete",
    aliasKeys: uniqueSecondaryLogicalKeys(aliasKeys, primaryKey),
    aggregateMemberships: uniqueSecondaryLogicalKeys(aggregateMemberships, primaryKey)
  };
}

/** Infers a typed identity from a pack-relative assets path when unambiguous. */
export function canonicalizeResourceGraphOutputPath(
  outputPath: string,
  options: CanonicalizeResourceGraphOutputPathOptions = {}
): CanonicalResourceGraphIdentity | null {
  const normalized = normalizeResourceGraphFileSystemPath(outputPath, {
    caseSensitive: true
  });
  if (!normalized) {
    return null;
  }
  const segments = normalized.split("/").filter(Boolean);
  const structuralSegments = options.fileSystemCaseSensitive === false
    ? segments.map(segment => segment.toLowerCase())
    : segments;
  const assetsIndex = structuralSegments.lastIndexOf("assets");
  if (assetsIndex < 0 || assetsIndex + 3 > segments.length) {
    return null;
  }

  const namespace = segments[assetsIndex + 1];
  const directory = structuralSegments[assetsIndex + 2];
  const resourcePath = segments.slice(assetsIndex + 3).join("/");
  const inference = inferMinecraftResourceKindFromDirectory(directory, resourcePath);
  if (!inference) {
    return null;
  }
  return canonicalizeResourceGraphIdentity(
    inference.kind,
    `${namespace}:${resourcePath}`,
    { extension: inference.extension }
  );
}

export interface ResourceGraphFileSystemPathIdentityOptions {
  caseSensitive?: boolean;
}

/** Stable path evidence identity; this is deliberately separate from logical IDs. */
export function normalizeResourceGraphFileSystemPath(
  value: string,
  options: ResourceGraphFileSystemPathIdentityOptions = {}
): string | null {
  const withSlashes = value.replaceAll("\\", "/");
  const prefix = withSlashes.startsWith("//") ? "//" : withSlashes.startsWith("/") ? "/" : "";
  const normalized = withSlashes.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0 || (segments.length === 1 && /^[a-z]:$/i.test(segments[0]))) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const identity = `${prefix}${segments.join("/")}`;
  return options.caseSensitive === false ? identity.toLowerCase() : identity;
}

function resolveShaderKind(
  kind: string,
  resourcePath: string,
  configuredExtension: string | null | undefined
): "shaderVertex" | "shaderFragment" | null {
  if (kind === "shaderVertex" || kind === "shaderFragment") {
    return kind;
  }
  if (kind !== "shader") {
    return null;
  }
  const extension = normalizeExtension(configuredExtension)
    ?? (resourcePath.endsWith(".vsh") ? "vsh" : resourcePath.endsWith(".fsh") ? "fsh" : null);
  return extension === "vsh"
    ? "shaderVertex"
    : extension === "fsh" ? "shaderFragment" : null;
}

function stripExpectedExtension(
  id: MinecraftResourceId,
  extension: string | null
): MinecraftResourceId | null {
  const suffix = extension ? `.${extension}` : "";
  const path = suffix && id.path.endsWith(suffix)
    ? id.path.slice(0, -suffix.length)
    : id.path;
  return tryParseMinecraftResourceId(`${id.namespace}:${path}`);
}

function normalizeExtension(extension: string | null | undefined): string | null {
  if (!extension) {
    return null;
  }
  return extension.startsWith(".") ? extension.slice(1) : extension;
}

function textureDirectoryMemberships(id: MinecraftResourceId): ResourceGraphLogicalKey[] {
  const segments = id.path.split("/");
  const memberships: ResourceGraphLogicalKey[] = [];
  for (let length = 1; length < segments.length; length++) {
    memberships.push({
      kind: "textureDirectory",
      id: minecraftResourceIdToString({
        namespace: id.namespace,
        path: segments.slice(0, length).join("/")
      })
    });
  }
  return memberships;
}

export function logicalKeyIdentity(key: ResourceGraphLogicalKey): string {
  return `${key.kind}\0${key.id}`;
}

export function uniqueLogicalKeys<TKey extends ResourceGraphLogicalKey>(keys: readonly TKey[]): TKey[] {
  return [...new Map(keys.map(key => [logicalKeyIdentity(key), key])).values()];
}

function uniqueSecondaryLogicalKeys(
  keys: readonly ResourceGraphLogicalKey[],
  primaryKey: ResourceGraphLogicalKey
): ResourceGraphLogicalKey[] {
  const primaryIdentity = logicalKeyIdentity(primaryKey);
  return uniqueLogicalKeys(keys.filter(key => logicalKeyIdentity(key) !== primaryIdentity));
}
