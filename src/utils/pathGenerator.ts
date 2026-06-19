import * as path from "node:path";
import * as fs from "node:fs";
import { Uri, workspace } from "vscode";
import { getDocumentResourceRootCandidates, parseResourceLocation } from "./resourceLocation";

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
}

export function createResourcePathResolver(): ResourcePathResolver {
  const pathExistsCache = new Map<string, boolean>();

  return (resourcePath, document, target, source, targetFileExtension) => generateRedirectPath(
    resourcePath,
    document,
    target,
    source,
    targetFileExtension,
    {
      pathExists: filePath => {
        const cached = pathExistsCache.get(filePath);
        if (cached !== undefined) {
          return cached;
        }

        const exists = fs.existsSync(filePath);
        pathExistsCache.set(filePath, exists);
        return exists;
      }
    }
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
  const location = parseResourceLocation(resourcePath, targetFileExtension);
  if (!location.isValid) {
    return null;
  }

  const candidates: string[] = [];
  const configuredDefaultPath = workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  for (const root of getDocumentResourceRootCandidates(
    document.fileName,
    source,
    configuredDefaultPath,
    location.namespace,
    target,
    { pathExists: options.pathExists }
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
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
