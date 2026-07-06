export interface MinecraftResourceId {
  namespace: string;
  path: string;
}

export interface ParsedMinecraftResourceId extends MinecraftResourceId {
  hasExplicitNamespace: boolean;
  isValid: boolean;
}

const pathPartSeparator = /[\\/]+/;
const namespacePattern = /^[a-z0-9_.-]+$/;
const resourcePathSegmentPattern = /^[a-z0-9._-]+$/;

export function parseMinecraftResourceId(input: string, defaultNamespace = "minecraft"): ParsedMinecraftResourceId {
  const [rawNamespace, ...rawPathParts] = input.split(":");
  const hasExplicitNamespace = rawPathParts.length > 0;
  const namespace = hasExplicitNamespace && rawNamespace.trim() ? rawNamespace.trim() : defaultNamespace;
  const rawPath = (hasExplicitNamespace ? rawPathParts.join(":") : rawNamespace).trim();
  const path = normalizeMinecraftResourcePath(rawPath);
  const isValid = isValidMinecraftNamespace(namespace) && isValidMinecraftResourcePath(path);

  return {
    namespace,
    path,
    hasExplicitNamespace,
    isValid
  };
}

export function tryParseMinecraftResourceId(input: string, defaultNamespace = "minecraft"): MinecraftResourceId | null {
  const parsed = parseMinecraftResourceId(input, defaultNamespace);
  return parsed.isValid
    ? { namespace: parsed.namespace, path: parsed.path }
    : null;
}

export function isMinecraftResourceLocationText(input: string): boolean {
  const parsed = parseMinecraftResourceId(input);
  return parsed.hasExplicitNamespace && parsed.isValid;
}

export function normalizeMinecraftResourcePath(input: string): string {
  return input
    .split(pathPartSeparator)
    .filter(segment => segment.length > 0 && segment !== ".")
    .join("/");
}

export function isValidMinecraftNamespace(namespace: string): boolean {
  return namespace !== ".." && namespacePattern.test(namespace);
}

export function isValidMinecraftResourcePath(resourcePath: string): boolean {
  const segments = resourcePath.split("/");
  return segments.length > 0 && segments.every(segment =>
    segment.length > 0 &&
    segment !== ".." &&
    resourcePathSegmentPattern.test(segment)
  );
}

export function minecraftResourceIdToString(id: MinecraftResourceId): string {
  return `${id.namespace}:${id.path}`;
}

export function qualifyMinecraftResourceId(value: string, defaultNamespace = "minecraft"): string {
  const id = tryParseMinecraftResourceId(value, defaultNamespace);
  if (id) {
    return minecraftResourceIdToString(id);
  }
  return value.includes(":") ? value : `${defaultNamespace}:${value}`;
}

export function minecraftResourceIdInFolder(value: string, defaultNamespace: string, folder: string): string {
  const id = tryParseMinecraftResourceId(value, defaultNamespace);
  if (!id) {
    return qualifyMinecraftResourceId(value, defaultNamespace);
  }
  const path = id.path.startsWith(`${folder}/`) ? id.path : `${folder}/${id.path}`;
  return minecraftResourceIdToString({ namespace: id.namespace, path });
}
