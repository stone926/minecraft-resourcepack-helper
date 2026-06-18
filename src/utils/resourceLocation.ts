import * as path from "node:path";

export interface ResourceLocation {
  namespace: string;
  resourcePath: string;
}

const pathPartSeparator = /[\\/]+/;

export function parseResourceLocation(input: string, targetFileExtension: string): ResourceLocation {
  const [rawNamespace, ...rawPathParts] = input.split(":");
  const hasNamespace = rawPathParts.length > 0;
  const namespace = hasNamespace && rawNamespace.trim() ? rawNamespace.trim() : "minecraft";
  const locationPath = (hasNamespace ? rawPathParts.join(":") : rawNamespace).trim();
  const normalizedSegments = locationPath.split(pathPartSeparator).filter(segment => segment.length > 0 && segment !== ".");
  let normalizedPath = normalizedSegments.join(path.sep);

  if (!normalizedPath.endsWith(`.${targetFileExtension}`)) {
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

function findSourceIndex(segments: string[], sourceSegments: string[]): number {
  for (let index = segments.length - sourceSegments.length; index >= 0; index--) {
    const matches = sourceSegments.every((segment, offset) => segments[index + offset] === segment);
    if (matches) {
      return index;
    }
  }

  return -1;
}
