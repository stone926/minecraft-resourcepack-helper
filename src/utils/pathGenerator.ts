import * as path from "node:path";
import * as fs from "node:fs";
import { Uri, workspace } from "vscode";
import { findAssetsRoot, getResourceRootCandidates, parseResourceLocation } from "./resourceLocation";

interface ResourcePathDocument {
  fileName: string;
}

export function generateRedirectPath(resourcePath: string, document: ResourcePathDocument, target: string, source: string, targetFileExtension: string | null): Uri | null {
  const location = parseResourceLocation(resourcePath, targetFileExtension);
  const currentAssetsRoot = findAssetsRoot(document.fileName, source);
  const candidates: string[] = [];
  const configuredDefaultPath = workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath");
  for (const root of getResourceRootCandidates(currentAssetsRoot, configuredDefaultPath, location.namespace, target)) {
    candidates.push(path.join(root, location.resourcePath));
  }

  for (const candidate of unique(candidates)) {
    if (fs.existsSync(candidate)) {
      return Uri.file(candidate);
    }
  }

  return null;
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
