import type { SerializedResourceUri } from "./types";

const absoluteUriPattern = /^[a-z][a-z0-9+.-]*:/i;
const windowsDrivePathPattern = /^[a-z]:[\\/]/i;
const windowsUncPathPattern = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

export function normalizeResourceProjectUri(value: string): SerializedResourceUri {
  const url = resourceProjectUrl(value);
  if (url.search || url.hash) {
    throw new Error(`Resource project URI cannot contain a query or fragment: ${value}`);
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.pathname = normalizeUriPathname(url.pathname, url.protocol === "file:");
  return trimNonRootTrailingSlash(url).toString();
}

export function resolveResourceProjectUri(
  baseUri: SerializedResourceUri,
  reference: string
): SerializedResourceUri {
  if (windowsDrivePathPattern.test(reference) || windowsUncPathPattern.test(reference)) {
    return windowsPathToFileUri(reference);
  }
  if (absoluteUriPattern.test(reference)) {
    return normalizeResourceProjectUri(reference);
  }

  const base = resourceProjectUrl(normalizeResourceProjectUri(baseUri));
  base.pathname = ensureTrailingSlash(base.pathname);
  const normalizedReference = reference
    .replaceAll("\\", "/")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F");
  return normalizeResourceProjectUri(new URL(normalizedReference, base).toString());
}

export function joinResourceProjectUri(
  baseUri: SerializedResourceUri,
  ...segments: readonly string[]
): SerializedResourceUri {
  const reference = segments
    .flatMap(segment => segment.replaceAll("\\", "/").split("/"))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return resolveResourceProjectUri(baseUri, reference);
}

export function resourceProjectUriParent(uri: SerializedResourceUri): SerializedResourceUri | null {
  const normalized = normalizeResourceProjectUri(uri);
  const url = resourceProjectUrl(normalized);
  const segments = pathnameSegments(url.pathname);
  if (segments.length === 0 || isWindowsDriveRoot(segments)) {
    return null;
  }
  segments.pop();
  url.pathname = `/${segments.join("/")}${segments.length > 0 ? "/" : ""}`;
  return normalizeResourceProjectUri(url.toString());
}

export function resourceProjectUriBasename(uri: SerializedResourceUri): string {
  const url = resourceProjectUrl(normalizeResourceProjectUri(uri));
  const segments = pathnameSegments(url.pathname);
  return decodeUriSegment(segments[segments.length - 1] ?? "");
}

export function isResourceProjectUriWithin(
  candidateUri: SerializedResourceUri,
  rootUri: SerializedResourceUri
): boolean {
  const candidate = resourceProjectUrl(normalizeResourceProjectUri(candidateUri));
  const root = resourceProjectUrl(normalizeResourceProjectUri(rootUri));
  if (candidate.protocol !== root.protocol || candidate.host !== root.host) {
    return false;
  }
  const candidatePath = caseAwareComparablePath(candidate);
  const rootPath = caseAwareComparablePath(root);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/** Comparison identity; Windows drive-backed file URIs use case-insensitive path semantics. */
export function resourceProjectUriIdentity(uri: SerializedResourceUri): string {
  const url = resourceProjectUrl(normalizeResourceProjectUri(uri));
  return `${url.protocol}//${url.host}${caseAwareComparablePath(url)}`;
}

export function resourceProjectUriDepth(uri: SerializedResourceUri): number {
  return pathnameSegments(resourceProjectUrl(normalizeResourceProjectUri(uri)).pathname).length;
}

export function compareResourceProjectUris(left: string, right: string): number {
  return resourceProjectUriIdentity(left).localeCompare(resourceProjectUriIdentity(right), "en")
    || normalizeResourceProjectUri(left).localeCompare(normalizeResourceProjectUri(right), "en");
}

function resourceProjectUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.pathname.startsWith("/")) {
      throw new Error("URI must be absolute and hierarchical.");
    }
    return url;
  } catch (error) {
    throw new Error(`Invalid absolute resource project URI '${value}'.`, { cause: error });
  }
}

function windowsPathToFileUri(value: string): SerializedResourceUri {
  const normalized = value.replaceAll("\\", "/");
  if (windowsUncPathPattern.test(value)) {
    const [host, ...segments] = normalized.replace(/^\/+/, "").split("/");
    return normalizeResourceProjectUri(`file://${host}/${segments.map(encodeURIComponent).join("/")}`);
  }
  const drive = normalized.slice(0, 2).toUpperCase();
  const tail = normalized.slice(2).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return normalizeResourceProjectUri(`file:///${drive}/${tail}`);
}

function normalizeUriPathname(pathname: string, fileUri: boolean): string {
  const segments = pathnameSegments(pathname);
  if (fileUri && segments[0] && /^[a-z]:$/i.test(decodeUriSegment(segments[0]))) {
    segments[0] = `${decodeUriSegment(segments[0])[0].toUpperCase()}:`;
  }
  return `/${segments.join("/")}${pathname.endsWith("/") && segments.length > 0 ? "/" : ""}`
    .replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
}

function pathnameSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function trimNonRootTrailingSlash(url: URL): URL {
  const segments = pathnameSegments(url.pathname);
  if (segments.length > 0 && !isWindowsDriveRoot(segments)) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isWindowsDriveRoot(segments: readonly string[]): boolean {
  return segments.length === 1 && /^[a-z]:$/i.test(decodeUriSegment(segments[0]));
}

function caseAwareComparablePath(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, "");
  return url.protocol === "file:" && /^\/[a-z]:/i.test(pathname)
    ? pathname.toLowerCase()
    : pathname;
}

function decodeUriSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
