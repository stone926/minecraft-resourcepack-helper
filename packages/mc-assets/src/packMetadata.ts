import * as fs from "node:fs";
import * as path from "node:path";

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

export interface PackMetadataReadOptions {
  pathExists?: (filePath: string) => boolean;
}

const currentResourcePackFormat: ResourcePackFormat = { major: 88, minor: 0 };
const currentLegacyBoundaryFormat = 64;
const overlayDirectoryPattern = /^[a-z0-9_-]+$/;

export function readPackMetadata(packRoot: string, options: PackMetadataReadOptions = {}): PackMetadata {
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

export function overlayApplies(entry: OverlayEntry): boolean {
  if (entry.minFormat || entry.maxFormat) {
    return (!entry.minFormat || compareFormats(currentResourcePackFormat, entry.minFormat) >= 0) &&
      (!entry.maxFormat || compareFormats(currentResourcePackFormat, entry.maxFormat) <= 0);
  }

  if (entry.legacyFormats) {
    return currentLegacyBoundaryFormat >= entry.legacyFormats.min && currentLegacyBoundaryFormat <= entry.legacyFormats.max;
  }

  return false;
}

export function resourceMatchesFilters(
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
  if (!isObjectRecord(raw)) {
    return null;
  }
  const filter = objectRecord(raw);
  return {
    namespace: typeof filter.namespace === "string" ? filter.namespace : null,
    path: typeof filter.path === "string" ? filter.path : null
  };
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
    Number.isInteger(objectValue.max_inclusive) &&
    objectValue.min_inclusive > 0 &&
    objectValue.max_inclusive >= objectValue.min_inclusive
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
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] > 0 &&
    value[0] <= value[1];
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
  return isObjectRecord(value)
    ? value as Record<string, unknown>
    : {};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
