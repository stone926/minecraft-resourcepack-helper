import * as path from "node:path";

export interface ResourceLocation {
  namespace: string;
  resourcePath: string;
}

const pathPartSeparator = /[\\/]+/;

export function parseResourceLocation(input: string, targetFileExtension: string | null): ResourceLocation {
  const [rawNamespace, ...rawPathParts] = input.split(":");
  const hasNamespace = rawPathParts.length > 0;
  const namespace = hasNamespace && rawNamespace.trim() ? rawNamespace.trim() : "minecraft";
  const locationPath = (hasNamespace ? rawPathParts.join(":") : rawNamespace).trim();
  const normalizedSegments = locationPath.split(pathPartSeparator).filter(segment => segment.length > 0 && segment !== ".");
  let normalizedPath = normalizedSegments.join(path.sep);

  if (targetFileExtension && !normalizedPath.endsWith(`.${targetFileExtension}`)) {
    normalizedPath += `.${targetFileExtension}`;
  }

  return {
    namespace,
    resourcePath: normalizedPath
  };
}

export function findAssetsRoot(fileName: string, source: string): string | null {
  const normalizedFileName = path.normalize(fileName);
  const parsedPath = path.parse(normalizedFileName);
  const relativePath = path.relative(parsedPath.root, normalizedFileName);
  const segments = relativePath.split(path.sep).filter(Boolean);
  const sourceSegments = normalizePathPart(source).split(path.sep).filter(Boolean);
  const sourceIndex = findSourceIndex(segments, sourceSegments);

  if (sourceIndex < 2 || segments[sourceIndex - 2] !== "assets") {
    return null;
  }

  return path.join(parsedPath.root, ...segments.slice(0, sourceIndex - 1));
}

export function normalizePathPart(value: string): string {
  return value.split(pathPartSeparator).filter(Boolean).join(path.sep);
}

export function getResourceRootCandidates(assetsRoot: string | null, defaultAssetsPath: string | null | undefined, namespace: string, target: string): string[] {
  const targetPath = normalizePathPart(target);
  const candidates: string[] = [];

  if (assetsRoot) {
    candidates.push(path.join(assetsRoot, namespace, targetPath));
  }

  if (defaultAssetsPath) {
    const defaultPath = path.normalize(defaultAssetsPath);
    candidates.push(
      path.join(defaultPath, namespace, targetPath),
      path.join(defaultPath, targetPath),
      path.join(defaultPath, "assets", namespace, targetPath)
    );
  }

  return [...new Set(candidates)];
}

function findSourceIndex(segments: string[], sourceSegments: string[]): number {
  for (let index = segments.length - sourceSegments.length; index >= 0; index--) {
    const matches = sourceSegments.every((segment, offset) => segments[index + offset] === segment);
    if (matches) {
      return index;
    }
  }

  return -1;
}
