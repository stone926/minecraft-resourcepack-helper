import { Uri } from "vscode";
import { resolveCitReferenceAsset } from "../cit/citAssetResolver";
import { workspaceResourceCache, type WorkspaceResourceCache } from "../services/workspaceResourceCache";
import { getResourceConfiguration } from "./resourceConfiguration";
import type { ResourceReference } from "./resourceReferences";

interface ResourcePathDocument {
  fileName: string;
}

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

export function createResourceReferencePathResolver(cache: ResourcePathResolutionHost = workspaceResourceCache): ResourceReferencePathResolver {
  return (reference, document) => generateReferenceRedirectPath(reference, document, { cache });
}

export function generateReferenceRedirectPath(
  reference: ResourceReference,
  document: ResourcePathDocument,
  options: ResourcePathResolverOptions = {}
): Uri | null {
  if (reference.resolveMode === "cit") {
    const host = getResolutionHost(options);
    const resolvedPath = resolveCitReferenceAsset(document.fileName, reference, {
      pathExists: fileName => host.getPathExists(fileName),
      getPackRoot: fileName => host.getPackRoot(fileName),
      resolveTypedResource: () => resolveRedirectFilePath(
        reference.value,
        document,
        reference.target,
        reference.source,
        reference.extension,
        options
      )
    });
    return resolvedPath ? Uri.file(resolvedPath) : null;
  }

  const resolvedPath = resolveRedirectFilePath(
    reference.value,
    document,
    reference.target,
    reference.source,
    reference.extension,
    options
  );
  return resolvedPath ? Uri.file(resolvedPath) : null;
}

function resolveRedirectFilePath(
  resourcePath: string,
  document: ResourcePathDocument,
  target: string,
  source: string,
  targetFileExtension: string | null,
  options: ResourcePathResolverOptions
): string | null {
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
  return resolvedPath;
}

function getResolutionHost(options: ResourcePathResolverOptions): ResourcePathResolutionHost {
  return options.cache ?? workspaceResourceCache;
}
