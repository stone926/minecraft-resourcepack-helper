import * as path from "node:path";
import * as fs from "node:fs";
import { TextDocument, Uri, workspace } from "vscode";
import { findAssetsRoot, normalizePathPart, parseResourceLocation, ResourceLocation } from "./resourceLocation";

export function generateRedirectPath(resourcePath: string, document: TextDocument, target: string, source: string, targetFileExtension: string): Uri | null {
  const location = parseResourceLocation(resourcePath, targetFileExtension);
  const currentAssetsRoot = findAssetsRoot(document.fileName, source);
  const candidates: string[] = [];

  if (currentAssetsRoot) {
    candidates.push(path.join(currentAssetsRoot, location.namespace, normalizePathPart(target), location.resourcePath));
  }

  for (const defaultCandidate of getDefaultAssetsCandidates(location, target)) {
    candidates.push(defaultCandidate);
  }

  for (const candidate of unique(candidates)) {
    if (fs.existsSync(candidate)) {
      return Uri.file(candidate);
    }
  }

  return null;
}

function getDefaultAssetsCandidates(location: ResourceLocation, target: string): string[] {
  const configuredDefaultPath = workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");

  if (!configuredDefaultPath) {
    return [];
  }

  const defaultPath = path.normalize(configuredDefaultPath);
  const targetPath = normalizePathPart(target);

  return [
    path.join(defaultPath, location.namespace, targetPath, location.resourcePath),
    path.join(defaultPath, targetPath, location.resourcePath),
    path.join(defaultPath, "assets", location.namespace, targetPath, location.resourcePath)
  ];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
