import * as path from "node:path";
import { Uri } from "vscode";
import { getCitAutoDiscoveryPathCandidates, getCitPathCandidates, type CitResourceType } from "../cit/citPaths";
import { packRootFromAssetsPath } from "../../packages/mc-assets/src";
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

export interface ResourcePathResolutionHost {
  resolveResourcePath(request: Parameters<WorkspaceResourceCache["resolveResourcePath"]>[0]): string | null;
  getPathExists(fileName: string): boolean;
  getPackRoot(fileName: string): string | null;
}

interface ResourcePathResolverOptions {
  cache?: ResourcePathResolutionHost;
}

export function createResourcePathResolver(cache: ResourcePathResolutionHost = workspaceResourceCache): ResourcePathResolver {
  return (resourcePath, document, target, source, targetFileExtension) => generateRedirectPath(
    resourcePath,
    document,
    target,
    source,
    targetFileExtension,
    { cache }
  );
}

export function createResourceReferencePathResolver(cache: ResourcePathResolutionHost = workspaceResourceCache): ResourceReferencePathResolver {
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
  const resolvedPath = getResolutionHost(options).resolveResourcePath({
    resourcePath,
    sourceFileName: document.fileName,
    source,
    target,
    targetFileExtension,
    defaultAssetsPath: configuredDefaultPath,
    resourcePackRoots: configuredResourcePackRoots
  });
  return resolvedPath ? Uri.file(resolvedPath) : null;
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

  const host = getResolutionHost(options);
  const packRoot = getCitPackRoot(document.fileName, host);

  if (packRoot) {
    for (const candidate of getCitPathCandidates(document.fileName, packRoot, reference.value, resourceType)) {
      if (host.getPathExists(candidate)) {
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
  const host = getResolutionHost(options);
  const packRoot = getCitPackRoot(document.fileName, host);
  if (!packRoot) {
    return null;
  }

  for (const candidate of getCitAutoDiscoveryPathCandidates(document.fileName, packRoot, reference.value)) {
    if (host.getPathExists(candidate)) {
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
  host: ResourcePathResolutionHost
): string | null {
  return host.getPackRoot(fileName) ?? packRootFromAssetsPath(fileName);
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

function getResolutionHost(options: ResourcePathResolverOptions): ResourcePathResolutionHost {
  return options.cache ?? workspaceResourceCache;
}
