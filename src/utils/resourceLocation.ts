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
  getPackRoot?: (fileName: string) => string | null;
  getPackMetadata?: (packRoot: string) => PackMetadata;
  resourcePath?: string;
  resourcePackRoots?: string[];
}

export interface PackMetadata {
  overlays: OverlayEntry[];
  filters: ResourceFilter[];
}

export interface OverlayEntry {
  directory: string;
  minFormat: ResourcePackFormat | null;
  maxFormat: ResourcePackFormat | null;
  legacyFormats: LegacyFormatRange | null;
}

export interface ResourceFilter {
  namespace: string | null;
  path: string | null;
}

export interface ResourcePackFormat {
  major: number;
  minor: number;
}

export interface LegacyFormatRange {
  min: number;
  max: number;
}

const currentResourcePackFormat: ResourcePackFormat = { major: 88, minor: 0 };
const currentLegacyBoundaryFormat = 64;
const overlayDirectoryPattern = /^[a-z0-9_-]+$/;

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

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);

  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
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

function resourceMatchesFilters(
  filters: ResourceFilter[],
  namespace: string,
  resourcePath: string | undefined
): boolean {
  if (!resourcePath) {
    return false;
  }

  const normalizedResourcePath = resourcePath.replaceAll("\\", "/");
  return filters.some(filter => {
    const namespacePattern = filter.namespace ?? ".*";
    const pathPattern = filter.path ?? ".*";
    return regexMatches(namespacePattern, namespace) && regexMatches(pathPattern, normalizedResourcePath);
  });
}

function getPackMetadata(packRoot: string, options: ResourceRootCandidateOptions): PackMetadata {
  return options.getPackMetadata ? options.getPackMetadata(packRoot) : readPackMetadata(packRoot, options);
}

export function readPackMetadata(packRoot: string, options: ResourceRootCandidateOptions = {}): PackMetadata {
  const packMcmetaPath = path.join(packRoot, "pack.mcmeta");
  try {
    if (options.pathExists && !options.pathExists(packMcmetaPath)) {
      return { overlays: [], filters: [] };
    }
    const raw = JSON.parse(fs.readFileSync(packMcmetaPath, "utf8")) as unknown;
    return parsePackMetadata(raw);
  } catch {
    return { overlays: [], filters: [] };
  }
}

export function parsePackMetadata(raw: unknown): PackMetadata {
  const root = objectRecord(raw);
  const overlays = objectRecord(root.overlays);
  const entries = Array.isArray(overlays.entries) ? overlays.entries : [];
  const filter = objectRecord(root.filter);
  const blockFilters = Array.isArray(filter.block) ? filter.block : [];

  return {
    overlays: entries.map(parseOverlayEntry).filter((entry): entry is OverlayEntry => entry !== null),
    filters: blockFilters.map(parseResourceFilter).filter((entry): entry is ResourceFilter => entry !== null)
  };
}

function parseOverlayEntry(raw: unknown): OverlayEntry | null {
  const entry = objectRecord(raw);
  const directory = typeof entry.directory === "string" ? entry.directory : null;
  if (!directory || !overlayDirectoryPattern.test(directory)) {
    return null;
  }

  return {
    directory,
    minFormat: parseResourcePackFormat(entry.min_format, false),
    maxFormat: parseResourcePackFormat(entry.max_format, true),
    legacyFormats: parseLegacyFormatRange(entry.formats)
  };
}

function parseResourceFilter(raw: unknown): ResourceFilter | null {
  const filter = objectRecord(raw);
  return {
    namespace: typeof filter.namespace === "string" ? filter.namespace : null,
    path: typeof filter.path === "string" ? filter.path : null
  };
}

function overlayApplies(entry: OverlayEntry): boolean {
  if (entry.minFormat || entry.maxFormat) {
    return (!entry.minFormat || compareFormats(currentResourcePackFormat, entry.minFormat) >= 0) &&
      (!entry.maxFormat || compareFormats(currentResourcePackFormat, entry.maxFormat) <= 0);
  }

  if (entry.legacyFormats) {
    return currentLegacyBoundaryFormat >= entry.legacyFormats.min && currentLegacyBoundaryFormat <= entry.legacyFormats.max;
  }

  return false;
}

function parseResourcePackFormat(value: unknown, isMaxFormat: boolean): ResourcePackFormat | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return {
      major: value,
      minor: isMaxFormat ? Number.MAX_SAFE_INTEGER : 0
    };
  }

  if (!Array.isArray(value) || !isFormatTuple(value)) {
    return null;
  }

  return {
    major: value[0],
    minor: value.length === 2 ? value[1] : (isMaxFormat ? Number.MAX_SAFE_INTEGER : 0)
  };
}

function parseLegacyFormatRange(value: unknown): LegacyFormatRange | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { min: value, max: value };
  }

  if (Array.isArray(value) && isLegacyFormatTuple(value)) {
    return { min: value[0], max: value[1] };
  }

  const objectValue = objectRecord(value);
  if (
    typeof objectValue.min_inclusive === "number" &&
    typeof objectValue.max_inclusive === "number" &&
    Number.isInteger(objectValue.min_inclusive) &&
    Number.isInteger(objectValue.max_inclusive)
  ) {
    return { min: objectValue.min_inclusive, max: objectValue.max_inclusive };
  }

  return null;
}

function isFormatTuple(value: unknown[]): value is [number] | [number, number] {
  return value.length >= 1 &&
    value.length <= 2 &&
    value.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0);
}

function isLegacyFormatTuple(value: unknown[]): value is [number, number] {
  return value.length === 2 &&
    value.every(item => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function compareFormats(left: ResourcePackFormat, right: ResourcePackFormat): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }

  return left.minor - right.minor;
}

function regexMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
