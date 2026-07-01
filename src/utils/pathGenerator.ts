import * as path from "node:path";
import * as fs from "node:fs";
import { Uri, workspace } from "vscode";
import { getDocumentResourceRootCandidates, parseResourceLocation } from "./resourceLocation";
import { workspaceResourceCache, type WorkspaceResourceCache } from "../services/workspaceResourceCache";

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

export function generateRedirectPath(
  resourcePath: string,
  document: ResourcePathDocument,
  target: string,
  source: string,
  targetFileExtension: string | null,
  options: ResourcePathResolverOptions = {}
): Uri | null {
  const configuredDefaultPath = workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  const configuredResourcePackRoots = workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? [];
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

function shouldUseWorkspaceCache(options: ResourcePathResolverOptions): boolean {
  return !options.pathExists && !options.getPackRoot && !options.getPackMetadata;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
