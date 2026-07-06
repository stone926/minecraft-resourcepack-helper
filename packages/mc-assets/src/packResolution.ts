import * as fs from "node:fs";
import * as path from "node:path";
import { parseMinecraftResourceId } from "./resourceId";
import { isSamePath } from "./pathKeys";
import {
  overlayApplies,
  readPackMetadata,
  resourceMatchesFilters,
  type PackMetadata
} from "./packMetadata";

export interface ResourceLocation {
  namespace: string;
  resourcePath: string;
  isValid: boolean;
}

export interface ResourceRootCandidateOptions {
  pathExists?: (filePath: string) => boolean;
  getPackRoot?: (fileName: string) => string | null;
  getPackMetadata?: (packRoot: string) => PackMetadata;
  resourcePath?: string;
  resourcePackRoots?: string[];
}

const pathPartSeparator = /[\\/]+/;

export function parseResourceLocation(input: string, targetFileExtension: string | null): ResourceLocation {
  const parsed = parseMinecraftResourceId(input);
  let normalizedPath = parsed.path.replaceAll("/", path.sep);

  if (targetFileExtension && !normalizedPath.endsWith(`.${targetFileExtension}`)) {
    normalizedPath += `.${targetFileExtension}`;
  }

  return {
    namespace: parsed.namespace,
    resourcePath: normalizedPath,
    isValid: parsed.isValid
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

export function getDocumentResourceRootCandidates(
  fileName: string,
  source: string,
  defaultAssetsPath: string | null | undefined,
  namespace: string,
  target: string,
  options: ResourceRootCandidateOptions = {}
): string[] {
  const assetsRoot = findAssetsRoot(fileName, source);
  const packRoot = options.getPackRoot ? options.getPackRoot(fileName) : findPackRoot(fileName, options);
  const candidates = packRoot
    ? getPackResourceRootCandidates(packRoot, assetsRoot, namespace, target, options)
    : getResourceRootCandidates(assetsRoot, null, namespace, target);
  const higherPriorityFilters = packRoot ? [...getPackMetadata(packRoot, options).filters] : [];

  for (const lowerPriorityPackRoot of getConfiguredLowerPriorityPackRoots(packRoot, options.resourcePackRoots)) {
    if (!resourceMatchesFilters(higherPriorityFilters, namespace, options.resourcePath)) {
      candidates.push(...getPackResourceRootCandidates(lowerPriorityPackRoot, null, namespace, target, options));
      higherPriorityFilters.push(...getPackMetadata(lowerPriorityPackRoot, options).filters);
    }
  }

  const blocksDefaultAssets = resourceMatchesFilters(higherPriorityFilters, namespace, options.resourcePath);

  if (!blocksDefaultAssets) {
    candidates.push(...getResourceRootCandidates(null, defaultAssetsPath, namespace, target));
  }

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

export function findPackRoot(fileName: string, options: ResourceRootCandidateOptions = {}): string | null {
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

function getPackResourceRootCandidates(
  packRoot: string,
  currentAssetsRoot: string | null,
  namespace: string,
  target: string,
  options: ResourceRootCandidateOptions
): string[] {
  const metadata = getPackMetadata(packRoot, options);
  const baseAssetsRoot = path.join(packRoot, "assets");
  const candidates: string[] = [];
  const activeOverlayRoots = metadata.overlays
    .filter(overlay => overlayApplies(overlay))
    .map(overlay => path.join(packRoot, overlay.directory, "assets"))
    .reverse();

  for (const overlayAssetsRoot of activeOverlayRoots) {
    candidates.push(...getResourceRootCandidates(overlayAssetsRoot, null, namespace, target));
  }

  if (currentAssetsRoot && !isSamePath(currentAssetsRoot, baseAssetsRoot) && !activeOverlayRoots.some(root => isSamePath(root, currentAssetsRoot))) {
    candidates.unshift(...getResourceRootCandidates(currentAssetsRoot, null, namespace, target));
  }

  candidates.push(...getResourceRootCandidates(baseAssetsRoot, null, namespace, target));
  return candidates;
}

function getConfiguredLowerPriorityPackRoots(currentPackRoot: string | null, configuredRoots: string[] | undefined): string[] {
  if (!configuredRoots) {
    return [];
  }

  return configuredRoots
    .map(root => path.normalize(root))
    .filter(root => root.length > 0 && (!currentPackRoot || !isSamePath(root, currentPackRoot)));
}

function getPackMetadata(packRoot: string, options: ResourceRootCandidateOptions): PackMetadata {
  return options.getPackMetadata ? options.getPackMetadata(packRoot) : readPackMetadata(packRoot, options);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
