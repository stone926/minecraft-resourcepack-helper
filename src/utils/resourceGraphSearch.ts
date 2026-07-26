import * as path from "node:path";
import {
  getAssetsResource,
  normalizePathKey,
  stripPathExtension,
  type AssetsResource
} from "../../packages/mc-assets/src";
import {
  getResourceIncomingReferenceRoots,
  isResourceSurfaceFile,
  type ResourceIncomingReferenceRoot
} from "../resources/resourceSurfaceRegistry";

export type AssetResource = AssetsResource;

export interface IncomingReferenceSearch {
  readonly values: Set<string>;
  matchesText(text: string): boolean;
}

interface AssetUriLike {
  readonly scheme: string;
  readonly fsPath: string;
}

export function createIncomingReferenceSearch(targetUri: AssetUriLike): IncomingReferenceSearch | null {
  const targetResource = targetUri.scheme === "file" ? getAssetResource(targetUri.fsPath) : null;
  if (!targetResource) {
    return null;
  }

  const values = new Set<string>();
  for (const rawPath of getPossibleReferencePaths(targetResource.resourcePath)) {
    addSearchValues(values, targetResource.namespace, rawPath);
  }

  return {
    values,
    matchesText: (text: string) => {
      if (text.includes("\\u")) {
        return true;
      }

      for (const value of values) {
        if (text.includes(value)) {
          return true;
        }
      }

      return false;
    }
  };
}

export function getAssetResource(fsPath: string): AssetResource | null {
  return getAssetsResource(fsPath);
}

export function resourceUriKey(uri: AssetUriLike): string {
  return uri.scheme === "file" ? normalizePathKey(uri.fsPath) : uri.toString();
}

export function isModelDocumentPath(fileName: string): boolean {
  return /[\\/]models[\\/].+\.json$/i.test(fileName);
}

export function isResourceJsonDocumentPath(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/].+\.json$/i.test(fileName);
}

export function isResourceGraphDocumentPath(fileName: string): boolean {
  return isResourceSurfaceFile(fileName, "graph");
}

function getPossibleReferencePaths(resourcePath: string): Set<string> {
  const paths = new Set<string>();
  const normalizedResourcePath = resourcePath.replaceAll("\\", "/");
  const pathWithoutExtension = stripPathExtension(normalizedResourcePath);
  const basenameWithoutExtension = path.posix.basename(pathWithoutExtension);
  const basename = path.posix.basename(normalizedResourcePath);
  for (const targetRoot of getResourceIncomingReferenceRoots()) {
    addReferencePathForTargetRoot(paths, normalizedResourcePath, pathWithoutExtension, targetRoot);
  }

  if (basenameWithoutExtension.length > 0) {
    paths.add(basenameWithoutExtension);
  }
  if (basename.length > 0) {
    paths.add(basename);
  }

  return paths;
}

function addReferencePathForTargetRoot(
  paths: Set<string>,
  resourcePath: string,
  pathWithoutExtension: string,
  target: ResourceIncomingReferenceRoot
): void {
  const targetRoot = target.root;
  const normalizedRoot = targetRoot.length > 0 ? `${targetRoot}/` : "";
  if (targetRoot.length > 0 && !resourcePath.startsWith(normalizedRoot)) {
    return;
  }

  let rawPath = targetRoot.length > 0 ? resourcePath.slice(normalizedRoot.length) : resourcePath;
  let rawPathWithoutExtension = targetRoot.length > 0
    ? pathWithoutExtension.slice(normalizedRoot.length)
    : pathWithoutExtension;

  for (let index = 0; index < (target.stripLeadingSegments ?? 0); index++) {
    const slashIndex = rawPath.indexOf("/");
    if (slashIndex < 0) {
      return;
    }
    rawPath = rawPath.slice(slashIndex + 1);
    const extensionlessSlashIndex = rawPathWithoutExtension.indexOf("/");
    rawPathWithoutExtension = extensionlessSlashIndex < 0
      ? ""
      : rawPathWithoutExtension.slice(extensionlessSlashIndex + 1);
  }

  if (rawPathWithoutExtension.length > 0) {
    paths.add(rawPathWithoutExtension);
  }

  if (rawPath.length > 0) {
    paths.add(rawPath);
  }
}

function addSearchValues(values: Set<string>, namespace: string, rawPath: string): void {
  const normalizedPath = rawPath.replaceAll("\\", "/");
  addJsonStringValues(values, `${namespace}:${normalizedPath}`);
  addJsonStringValues(values, `${namespace.toLowerCase()}:${normalizedPath.toLowerCase()}`);
  values.add(`${namespace}:${normalizedPath}`);
  values.add(`${namespace.toLowerCase()}:${normalizedPath.toLowerCase()}`);
  values.add(`assets/${namespace}/${normalizedPath}`);
  values.add(`assets/${namespace.toLowerCase()}/${normalizedPath.toLowerCase()}`);
  values.add(normalizedPath);
  values.add(normalizedPath.toLowerCase());

  if (namespace === "minecraft") {
    addJsonStringValues(values, normalizedPath);
    addJsonStringValues(values, normalizedPath.toLowerCase());
  }
}

function addJsonStringValues(values: Set<string>, value: string): void {
  values.add(JSON.stringify(value));

  if (value.includes("/")) {
    values.add(JSON.stringify(value.replaceAll("/", "\\")));
    values.add(JSON.stringify(value).replaceAll("/", "\\/"));
  }
}
