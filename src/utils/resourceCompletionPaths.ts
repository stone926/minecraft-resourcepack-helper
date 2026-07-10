import * as path from "node:path";
import { uniqueValues } from "../../packages/mc-assets/src";

export interface PartialResourcePath {
  namespace: string;
  explicitNamespace: boolean;
  directory: string;
  prefix: string;
}

export interface ResourceCompletionText {
  value: string;
  filterText: string;
}

export function parsePartialResourcePath(value: string): PartialResourcePath {
  const namespaceSeparator = value.indexOf(":");
  const explicitNamespace = namespaceSeparator >= 0;
  const namespace = explicitNamespace ? value.slice(0, namespaceSeparator) || "minecraft" : "minecraft";
  const resourcePath = explicitNamespace ? value.slice(namespaceSeparator + 1) : value;
  const slashIndex = Math.max(resourcePath.lastIndexOf("/"), resourcePath.lastIndexOf("\\"));

  if (slashIndex < 0) {
    return {
      namespace,
      explicitNamespace,
      directory: "",
      prefix: resourcePath
    };
  }

  return {
    namespace,
    explicitNamespace,
    directory: resourcePath.slice(0, slashIndex),
    prefix: resourcePath.slice(slashIndex + 1)
  };
}

export function buildResourceCompletionValue(partialPath: PartialResourcePath, label: string, isDirectory: boolean): string {
  const namespacePrefix = partialPath.explicitNamespace || partialPath.namespace !== "minecraft" ? `${partialPath.namespace}:` : "";
  const directoryPrefix = partialPath.directory.length > 0 ? `${partialPath.directory.replaceAll("\\", "/")}/` : "";
  return `${namespacePrefix}${directoryPrefix}${label}${isDirectory ? "/" : ""}`;
}

export function buildResourceCompletionText(
  partialPath: PartialResourcePath,
  label: string,
  isDirectory: boolean
): ResourceCompletionText {
  const value = buildResourceCompletionValue(partialPath, label, isDirectory);
  return {
    value,
    filterText: value
  };
}

export function shouldCompleteNamespaces(partialPath: PartialResourcePath): boolean {
  return !partialPath.explicitNamespace && partialPath.directory.length === 0;
}

export async function filterExistingResourceRoots(
  roots: string[],
  pathExists: (root: string) => boolean | Promise<boolean>
): Promise<string[]> {
  const existingRoots: string[] = [];
  for (const root of roots) {
    if (await pathExists(root)) {
      existingRoots.push(root);
    }
  }

  return existingRoots;
}

export function getAssetsRootCandidates(roots: string[], namespace: string, target: string): string[] {
  const targetSegmentCount = splitResourcePath(target).length;
  const assetsRoots: string[] = [];

  for (const root of roots) {
    let namespaceRoot = path.normalize(root);
    for (let index = 0; index < targetSegmentCount; index++) {
      namespaceRoot = path.dirname(namespaceRoot);
    }

    if (path.basename(namespaceRoot).toLowerCase() === namespace.toLowerCase()) {
      const assetsRoot = path.dirname(namespaceRoot);
      if (path.basename(assetsRoot) === "assets") {
        assetsRoots.push(assetsRoot);
      }
    }
  }

  return uniqueValues(assetsRoots);
}

export function splitResourcePath(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}
