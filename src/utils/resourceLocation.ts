import * as fs from "node:fs";
import * as path from "node:path";

export interface ResourceLocation {
  namespace: string;
  resourcePath: string;
  isValid: boolean;
}

const pathPartSeparator = /[\\/]+/;
const namespacePattern = /^[a-z0-9_.-]+$/;
const pathSegmentPattern = /^[a-z0-9._-]+$/;

interface ResourceRootCandidateOptions {
  pathExists?: (filePath: string) => boolean;
}

export function parseResourceLocation(input: string, targetFileExtension: string | null): ResourceLocation {
  const [rawNamespace, ...rawPathParts] = input.split(":");
  const hasNamespace = rawPathParts.length > 0;
  const namespace = hasNamespace && rawNamespace.trim() ? rawNamespace.trim() : "minecraft";
  const locationPath = (hasNamespace ? rawPathParts.join(":") : rawNamespace).trim();
  const rawSegments = locationPath.split(pathPartSeparator);
  const normalizedSegments = rawSegments.filter(segment => segment.length > 0 && segment !== ".");
  const isValid = isValidNamespace(namespace) && isValidResourcePath(normalizedSegments);
  let normalizedPath = normalizedSegments.join(path.sep);

  if (targetFileExtension && !normalizedPath.endsWith(`.${targetFileExtension}`)) {
    normalizedPath += `.${targetFileExtension}`;
  }

  return {
    namespace,
    resourcePath: normalizedPath,
    isValid
  };
}

function isValidNamespace(namespace: string): boolean {
  return namespace !== ".." && namespacePattern.test(namespace);
}

function isValidResourcePath(segments: string[]): boolean {
  return segments.length > 0 && segments.every(segment => segment !== ".." && pathSegmentPattern.test(segment));
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

export function getDocumentResourceRootCandidates(
  fileName: string,
  source: string,
  defaultAssetsPath: string | null | undefined,
  namespace: string,
  target: string,
  options: ResourceRootCandidateOptions = {}
): string[] {
  const assetsRoot = findAssetsRoot(fileName, source);
  const candidates = getResourceRootCandidates(assetsRoot, null, namespace, target);
  const basePackAssetsRoot = findBasePackAssetsRoot(fileName, assetsRoot, options);

  if (basePackAssetsRoot) {
    candidates.push(...getResourceRootCandidates(basePackAssetsRoot, null, namespace, target));
  }

  candidates.push(...getResourceRootCandidates(null, defaultAssetsPath, namespace, target));
  return unique(candidates);
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

function findBasePackAssetsRoot(
  fileName: string,
  currentAssetsRoot: string | null,
  options: ResourceRootCandidateOptions
): string | null {
  const packRoot = findPackRoot(fileName, options);
  if (!packRoot) {
    return null;
  }

  const baseAssetsRoot = path.join(packRoot, "assets");
  if (!currentAssetsRoot || isSamePath(baseAssetsRoot, currentAssetsRoot)) {
    return null;
  }

  return baseAssetsRoot;
}

function findPackRoot(fileName: string, options: ResourceRootCandidateOptions): string | null {
  const pathExists = options.pathExists ?? fs.existsSync;
  let current = path.dirname(path.normalize(fileName));
  const root = path.parse(current).root;

  while (true) {
    if (pathExists(path.join(current, "pack.mcmeta"))) {
      return current;
    }

    if (current === root) {
      return null;
    }

    current = path.dirname(current);
  }
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

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);

  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
