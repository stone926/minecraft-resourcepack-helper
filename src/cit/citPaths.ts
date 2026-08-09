import * as path from "node:path";
import {
  minecraftResourceTarget,
  packRootFromAssetsPath,
  parseMinecraftResourceId,
  startsWithPathSegment,
  uniqueValues
} from "../../packages/mc-assets/src";
import { getCitDocumentNamespace } from "../resources/citResourceSurface";
import type { CitResourceType } from "./citKeyResolution";

export {
  citresewnSourceDirectory,
  getCitDocumentInfo,
  getCitDocumentNamespace,
  getCitDocumentSource,
  isCitModelFileName,
  isCitPropertiesFileName,
  type CitDocumentInfo
} from "../resources/citResourceSurface";

export function getCitPathCandidates(
  documentFileName: string,
  packRoot: string,
  value: string,
  resourceType: CitResourceType
): string[] {
  const cleanValue = value.trim();
  if (cleanValue.length === 0) {
    return [];
  }

  if (path.isAbsolute(cleanValue)) {
    return [path.normalize(withExtension(cleanValue, resourceType))];
  }

  const documentDirectory = path.dirname(documentFileName);
  const normalizedValue = cleanValue.replace(/[\\/]+/g, path.sep);
  const candidates: string[] = [];

  if (startsWithPathSegment(normalizedValue, "assets")) {
    candidates.push(path.join(packRoot, withExtension(normalizedValue, resourceType)));
    return uniqueValues(candidates);
  }

  const resourceLocation = parseCitResourceLocation(normalizedValue);
  if (resourceLocation) {
    candidates.push(path.join(
      packRoot,
      "assets",
      resourceLocation.namespace,
      withExtension(resourceLocation.resourcePath, resourceType)
    ));
    candidates.push(path.join(
      packRoot,
      "assets",
      resourceLocation.namespace,
      resourceType,
      withExtension(resourceLocation.resourcePath, resourceType)
    ));
    return uniqueValues(candidates);
  }

  candidates.push(path.join(documentDirectory, withExtension(normalizedValue, resourceType)));
  if (!isForcedRelativePath(normalizedValue)) {
    const namespace = getCitDocumentNamespace(documentFileName);
    if (containsPathSeparator(normalizedValue)) {
      candidates.push(path.join(packRoot, "assets", namespace, withExtension(normalizedValue, resourceType)));
    }
    candidates.push(path.join(packRoot, "assets", namespace, resourceType, withExtension(normalizedValue, resourceType)));
  }
  return uniqueValues(candidates);
}

export function getCitAutoDiscoveryPathCandidates(
  documentFileName: string,
  packRoot: string,
  value: string
): string[] {
  return [
    ...getCitPathCandidates(documentFileName, packRoot, value, "models"),
    ...getCitPathCandidates(documentFileName, packRoot, value, "textures")
  ];
}

function parseCitResourceLocation(value: string): { namespace: string; resourcePath: string } | null {
  const parsed = parseMinecraftResourceId(value);
  if (!parsed.hasExplicitNamespace || !parsed.path) {
    return null;
  }
  // CIT historically accepts loosely-formed ids; validity is deliberately not enforced.
  return { namespace: parsed.namespace, resourcePath: parsed.path };
}

export const citResourceKindByType: Readonly<Record<CitResourceType, "texture" | "model">> = {
  textures: "texture",
  models: "model"
};

function withExtension(value: string, resourceType: CitResourceType): string {
  if (path.extname(value) !== "") {
    return value;
  }

  return `${value}.${minecraftResourceTarget(citResourceKindByType[resourceType]).extension}`;
}

/** Shared CIT pack-root fallback: explicit host lookup, then the assets-path heuristic. */
export function resolveCitPackRoot(
  fileName: string,
  getPackRoot: (fileName: string) => string | null | undefined
): string | null {
  return getPackRoot(fileName) ?? packRootFromAssetsPath(fileName);
}

/** `./`- or `../`-prefixed separator-normalized values (shared with the asset resolver). */
export function hasExplicitRelativePathPrefix(value: string): boolean {
  return value.startsWith(`.${path.sep}`) || value.startsWith(`..${path.sep}`);
}

function isForcedRelativePath(value: string): boolean {
  return value === "." || value === ".." || hasExplicitRelativePathPrefix(value);
}

function containsPathSeparator(value: string): boolean {
  return value.includes(path.sep);
}
