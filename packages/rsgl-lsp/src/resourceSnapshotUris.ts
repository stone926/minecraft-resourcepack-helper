import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Ephemeral host/LSP mapping. Canonical project DTOs remain URI-only. */
export interface RsglResourceUriNativePathMapping {
  uriRoot: string;
  fileSystemPath: string;
}

/** Converts a serialized file URI at the Node filesystem boundary. */
export function fileNameFromSerializedResourceUri(
  uri: string,
  mappings: readonly RsglResourceUriNativePathMapping[] = []
): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "file:") {
      return path.resolve(fileURLToPath(parsed));
    }
    const mapped = mappings
      .flatMap(mapping => mapUriWithinRoot(uri, mapping) ?? [])
      .sort((left, right) => right.uriRootLength - left.uriRootLength)[0];
    return mapped?.fileName ?? null;
  } catch {
    return null;
  }
}

/** Runtime guard for the optional, contentless host transport sidecar. */
export function resourceUriNativePathMappingsFromRequest(
  value: unknown
): RsglResourceUriNativePathMapping[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const mappings = (value as { nativePathMappings?: unknown }).nativePathMappings;
  if (!Array.isArray(mappings)) {
    return [];
  }
  const result = new Map<string, RsglResourceUriNativePathMapping>();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      continue;
    }
    const candidate = mapping as { uriRoot?: unknown; fileSystemPath?: unknown };
    if (typeof candidate.uriRoot !== "string"
      || typeof candidate.fileSystemPath !== "string"
      || candidate.fileSystemPath.length === 0) {
      continue;
    }
    try {
      const parsed = new URL(candidate.uriRoot);
      if (parsed.protocol !== "vscode-remote:") {
        continue;
      }
      result.set(normalizeUriRoot(parsed), {
        uriRoot: parsed.toString(),
        fileSystemPath: candidate.fileSystemPath
      });
    } catch {
      // Ignore malformed transport-only mappings without rejecting the request DTO.
    }
  }
  return [...result.values()];
}

/** Converts compiler-native paths and synthetic sources into serialized URIs. */
export function rsglSourceUriFromFileName(
  fileName: string,
  mappings: readonly RsglResourceUriNativePathMapping[] = []
): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(fileName) && !/^[a-zA-Z]:[\\/]/.test(fileName)) {
    return fileName;
  }
  if (fileName.startsWith("<")) {
    return `rsgl-source:${encodeURIComponent(fileName)}`;
  }
  const mapped = mappings
    .flatMap(mapping => mapFileNameWithinRoot(fileName, mapping) ?? [])
    .sort((left, right) => right.nativeRootLength - left.nativeRootLength)[0];
  if (mapped) {
    return mapped.uri;
  }
  return pathToFileURL(path.resolve(fileName)).toString();
}

export function isNativePathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function mapUriWithinRoot(
  uri: string,
  mapping: RsglResourceUriNativePathMapping
): { fileName: string; uriRootLength: number } | null {
  let candidate: URL;
  let root: URL;
  try {
    candidate = new URL(uri);
    root = new URL(mapping.uriRoot);
  } catch {
    return null;
  }
  if (candidate.protocol !== "vscode-remote:"
    || root.protocol !== candidate.protocol
    || root.host !== candidate.host) {
    return null;
  }
  const rootSegments = decodedUriPathSegments(root.pathname);
  const candidateSegments = decodedUriPathSegments(candidate.pathname);
  const windows = isWindowsNativePath(mapping.fileSystemPath);
  if (!rootSegments
    || !candidateSegments
    || rootSegments.length > candidateSegments.length
    || rootSegments.some((segment, index) =>
      !sameUriPathSegment(segment, candidateSegments[index], windows))) {
    return null;
  }
  const pathApi = windows ? path.win32 : path.posix;
  const nativeRoot = pathApi.resolve(mapping.fileSystemPath);
  const fileName = pathApi.resolve(nativeRoot, ...candidateSegments.slice(rootSegments.length));
  const relative = pathApi.relative(nativeRoot, fileName);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return null;
  }
  return { fileName, uriRootLength: root.pathname.length };
}

function mapFileNameWithinRoot(
  fileName: string,
  mapping: RsglResourceUriNativePathMapping
): { uri: string; nativeRootLength: number } | null {
  let root: URL;
  try {
    root = new URL(mapping.uriRoot);
  } catch {
    return null;
  }
  if (root.protocol !== "vscode-remote:") {
    return null;
  }
  const windows = isWindowsNativePath(mapping.fileSystemPath);
  const pathApi = windows ? path.win32 : path.posix;
  const nativeRoot = pathApi.resolve(mapping.fileSystemPath);
  const resolvedFileName = pathApi.resolve(fileName);
  const relative = pathApi.relative(nativeRoot, resolvedFileName);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return null;
  }
  const suffix = relative
    ? relative.split(pathApi.sep).filter(Boolean).map(encodeURIComponent).join("/")
    : "";
  const rootPath = root.pathname.replace(/\/+$/, "");
  return {
    uri: `${root.protocol}//${root.host}${rootPath}${suffix ? `/${suffix}` : ""}`,
    nativeRootLength: nativeRoot.length
  };
}

function decodedUriPathSegments(pathname: string): string[] | null {
  try {
    return pathname.split("/")
      .filter(Boolean)
      .map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function sameUriPathSegment(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isWindowsNativePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeUriRoot(uri: URL): string {
  return `${uri.protocol}//${uri.host}${uri.pathname.replace(/\/+$/, "")}`;
}
