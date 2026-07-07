import * as path from "node:path";
import * as fs from "node:fs";
import { Uri } from "vscode";
import { getCitAutoDiscoveryPathCandidates, getCitPathCandidates, type CitResourceType } from "../cit/citPaths";
import { findPackRoot, getDocumentResourceRootCandidates, packRootFromAssetsPath, parseResourceLocation } from "../../packages/mc-assets/src";
import { workspaceResourceCache, type WorkspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "./resourceConfiguration";
import type { ResourceReference } from "./resourceReferences";

interface ResourcePathDocument {
  fileName: string;
}

export type ResourcePathResolver = (
  resourcePath: string,
  document: ResourcePathDocument,
  target: string,
  source: string,
  targetFileExtension: string | null
) => Uri | null;
export type ResourceReferencePathResolver = (
  reference: ResourceReference,
  document: ResourcePathDocument
) => Uri | null;

interface ResourcePathResolverOptions {
  pathExists?: (filePath: string) => boolean;
  getPackRoot?: (fileName: string) => string | null;
  getPackMetadata?: (packRoot: string) => ReturnType<WorkspaceResourceCache["getPackMetadata"]>;
  cache?: WorkspaceResourceCache;
}

export function createResourcePathResolver(cache: WorkspaceResourceCache = workspaceResourceCache): ResourcePathResolver {
  return (resourcePath, document, target, source, targetFileExtension) => generateRedirectPath(
    resourcePath,
    document,
    target,
    source,
    targetFileExtension,
    { cache }
  );
}

export function createResourceReferencePathResolver(cache: WorkspaceResourceCache = workspaceResourceCache): ResourceReferencePathResolver {
  return (reference, document) => generateReferenceRedirectPath(reference, document, { cache });
}

export function generateReferenceRedirectPath(
  reference: ResourceReference,
  document: ResourcePathDocument,
  options: ResourcePathResolverOptions = {}
): Uri | null {
  if (reference.resolveMode === "cit") {
    return generateCitRedirectPath(reference, document, options);
  }

  return generateRedirectPath(reference.value, document, reference.target, reference.source, reference.extension, options);
}

export function generateRedirectPath(
  resourcePath: string,
  document: ResourcePathDocument,
  target: string,
  source: string,
  targetFileExtension: string | null,
  options: ResourcePathResolverOptions = {}
): Uri | null {
  const configuration = getResourceConfiguration();
  const configuredDefaultPath = configuration.defaultAssetsPath;
  const configuredResourcePackRoots = configuration.resourcePackRoots ?? [];
  const cache = shouldUseWorkspaceCache(options) ? (options.cache ?? workspaceResourceCache) : null;
  if (cache) {
    const resolvedPath = cache.resolveResourcePath({
      resourcePath,
      sourceFileName: document.fileName,
      target,
      source,
      targetFileExtension,
      defaultAssetsPath: configuredDefaultPath,
      resourcePackRoots: configuredResourcePackRoots
    });
    return resolvedPath ? Uri.file(resolvedPath) : null;
  }

  const location = parseResourceLocation(resourcePath, targetFileExtension);
  if (!location.isValid) {
    return null;
  }

  const candidates: string[] = [];
  for (const root of getDocumentResourceRootCandidates(
    document.fileName,
    source,
    configuredDefaultPath,
    location.namespace,
    target,
    {
      pathExists: options.pathExists,
      getPackRoot: options.getPackRoot,
      getPackMetadata: options.getPackMetadata,
      resourcePath: path.posix.join(target.replaceAll("\\", "/"), location.resourcePath.replaceAll(path.sep, "/")),
      resourcePackRoots: configuredResourcePackRoots
    }
  )) {
    candidates.push(path.join(root, location.resourcePath));
  }

  for (const candidate of unique(candidates)) {
    if ((options.pathExists ?? fs.existsSync)(candidate)) {
      return Uri.file(candidate);
    }
  }

  return null;
}

function generateCitRedirectPath(
  reference: ResourceReference,
  document: ResourcePathDocument,
  options: ResourcePathResolverOptions
): Uri | null {
  if (reference.origin === "citAutoDiscovery") {
    return generateCitAutoDiscoveryRedirectPath(reference, document, options);
  }

  const resourceType = getCitResourceTypeFromReference(reference);
  if (!resourceType) {
    return null;
  }

  const cache = shouldUseWorkspaceCache(options) ? (options.cache ?? workspaceResourceCache) : null;
  const pathExists = options.pathExists ?? (fileName => cache ? cache.getPathExists(fileName) : fs.existsSync(fileName));
  const packRoot = getCitPackRoot(document.fileName, options, cache, pathExists);

  if (packRoot) {
    for (const candidate of getCitPathCandidates(document.fileName, packRoot, reference.value, resourceType)) {
      if (pathExists(candidate)) {
        return Uri.file(candidate);
      }
    }
  }

  if (shouldTryCitTypedResourceFallback(reference.value)) {
    return generateRedirectPath(reference.value, document, reference.target, reference.source, reference.extension, options);
  }

  return null;
}

function generateCitAutoDiscoveryRedirectPath(
  reference: ResourceReference,
  document: ResourcePathDocument,
  options: ResourcePathResolverOptions
): Uri | null {
  const cache = shouldUseWorkspaceCache(options) ? (options.cache ?? workspaceResourceCache) : null;
  const pathExists = options.pathExists ?? (fileName => cache ? cache.getPathExists(fileName) : fs.existsSync(fileName));
  const packRoot = getCitPackRoot(document.fileName, options, cache, pathExists);
  if (!packRoot) {
    return null;
  }

  for (const candidate of getCitAutoDiscoveryPathCandidates(document.fileName, packRoot, reference.value)) {
    if (pathExists(candidate)) {
      return Uri.file(candidate);
    }
  }

  return null;
}

function getCitResourceTypeFromReference(reference: ResourceReference): CitResourceType | null {
  if (reference.target === "textures" && reference.extension === "png") {
    return "textures";
  }

  if (reference.target === "models" && reference.extension === "json") {
    return "models";
  }

  return null;
}

function getCitPackRoot(
  fileName: string,
  options: ResourcePathResolverOptions,
  cache: WorkspaceResourceCache | null,
  pathExists: (filePath: string) => boolean
): string | null {
  return options.getPackRoot?.(fileName) ??
    cache?.getPackRoot(fileName) ??
    findPackRoot(fileName, { pathExists }) ??
    packRootFromAssetsPath(fileName);
}

function shouldTryCitTypedResourceFallback(value: string): boolean {
  const cleanValue = value.trim();
  if (cleanValue.length === 0 || path.isAbsolute(cleanValue)) {
    return false;
  }

  const normalizedValue = cleanValue.replace(/[\\/]+/g, path.sep);
  return !startsWithPathSegment(normalizedValue, "assets") &&
    !normalizedValue.startsWith(`.${path.sep}`) &&
    !normalizedValue.startsWith(`..${path.sep}`);
}

function startsWithPathSegment(value: string, segment: string): boolean {
  const [firstSegment] = value.split(path.sep);
  return firstSegment?.toLowerCase() === segment.toLowerCase();
}

function shouldUseWorkspaceCache(options: ResourcePathResolverOptions): boolean {
  return !options.pathExists && !options.getPackRoot && !options.getPackMetadata;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
