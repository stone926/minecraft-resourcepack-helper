import * as path from "node:path";
import { parseAssetsPath, startsWithPathSegment, uniqueValues } from "../../packages/mc-assets/src";
import type { CitResourceType } from "./citKeyResolution";

export const citresewnSourceDirectory = "citresewn";

export interface CitDocumentInfo {
  namespace: string;
  source: string;
}

export function isCitPropertiesFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null && path.extname(fileName).toLowerCase() === ".properties";
}

export function isCitModelFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null && path.extname(fileName).toLowerCase() === ".json";
}

export function getCitDocumentSource(fileName: string): string {
  return getCitDocumentInfo(fileName)?.source ?? citresewnSourceDirectory;
}

export function getCitDocumentNamespace(fileName: string): string {
  return getCitDocumentInfo(fileName)?.namespace ?? "minecraft";
}

export function getCitDocumentInfo(fileName: string): CitDocumentInfo | null {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length < 2) {
    return null;
  }

  const relativeSegments = parsed.relativeSegments.slice(0, -1);
  if (!isCitRelativePath(relativeSegments)) {
    return null;
  }

  return {
    namespace: parsed.namespace,
    source: relativeSegments.join("/")
  };
}

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
  const namespaceSeparator = value.indexOf(":");
  if (namespaceSeparator < 0) {
    return null;
  }

  const namespace = value.slice(0, namespaceSeparator).trim() || "minecraft";
  const resourcePath = value.slice(namespaceSeparator + 1).trim();
  if (!resourcePath) {
    return null;
  }

  return { namespace, resourcePath };
}

function withExtension(value: string, resourceType: CitResourceType): string {
  if (path.extname(value) !== "") {
    return value;
  }

  return `${value}${resourceType === "textures" ? ".png" : ".json"}`;
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

function isCitRelativePath(segments: string[]): boolean {
  if (segments.length === 0) {
    return false;
  }

  const [root] = segments.map(segment => segment.toLowerCase());
  if (root === citresewnSourceDirectory) {
    return true;
  }

  return false;
}
