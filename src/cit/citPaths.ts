import * as path from "node:path";

export type CitResourceType = "textures" | "models";

export interface CitDocumentInfo {
  namespace: string;
  source: string;
}

export function getCitResourceType(key: string): CitResourceType | null {
  if (/^texture(\.|$)/.test(key)) {
    return "textures";
  }

  if (/^model(\.|$)/.test(key)) {
    return "models";
  }

  return null;
}

export function isCitPropertiesFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null && path.extname(fileName).toLowerCase() === ".properties";
}

export function isCitModelFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null && path.extname(fileName).toLowerCase() === ".json";
}

export function isCitGlobalPropertiesFileName(fileName: string): boolean {
  const normalizedPath = path.normalize(fileName);
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const assetsIndex = segments.findLastIndex(segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0 || segments.length <= assetsIndex + 3) {
    return false;
  }

  const namespace = segments[assetsIndex + 1].toLowerCase();
  const relativePath = segments.slice(assetsIndex + 2).map(segment => segment.toLowerCase()).join("/");

  return namespace === "minecraft" && (
    relativePath === "citresewn/cit.properties" ||
    relativePath === "optifine/cit.properties" ||
    relativePath === "mcpatcher/cit.properties"
  );
}

export function getCitDocumentSource(fileName: string): string {
  return getCitDocumentInfo(fileName)?.source ?? "citresewn";
}

export function getCitDocumentNamespace(fileName: string): string {
  return getCitDocumentInfo(fileName)?.namespace ?? "minecraft";
}

export function getCitDocumentInfo(fileName: string): CitDocumentInfo | null {
  const normalizedPath = path.normalize(fileName);
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const assetsIndex = segments.findLastIndex(segment => segment.toLowerCase() === "assets");
  if (assetsIndex < 0 || segments.length <= assetsIndex + 3) {
    return null;
  }

  const namespace = segments[assetsIndex + 1];
  const relativeSegments = segments.slice(assetsIndex + 2, -1);
  if (!isCitRelativePath(relativeSegments, segments[segments.length - 1])) {
    return null;
  }

  return {
    namespace,
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
    return unique(candidates);
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
    return unique(candidates);
  }

  candidates.push(path.join(documentDirectory, withExtension(normalizedValue, resourceType)));
  if (!isForcedRelativePath(normalizedValue)) {
    const namespace = getCitDocumentNamespace(documentFileName);
    if (containsPathSeparator(normalizedValue)) {
      candidates.push(path.join(packRoot, "assets", namespace, withExtension(normalizedValue, resourceType)));
    }
    candidates.push(path.join(packRoot, "assets", namespace, resourceType, withExtension(normalizedValue, resourceType)));
  }
  return unique(candidates);
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

function startsWithPathSegment(value: string, segment: string): boolean {
  const [firstSegment] = value.split(path.sep);
  return firstSegment?.toLowerCase() === segment.toLowerCase();
}

function isForcedRelativePath(value: string): boolean {
  return value === "." ||
    value === ".." ||
    value.startsWith(`.${path.sep}`) ||
    value.startsWith(`..${path.sep}`);
}

function containsPathSeparator(value: string): boolean {
  return value.includes(path.sep);
}

function isCitRelativePath(segments: string[], fileName: string): boolean {
  if (segments.length === 0) {
    return false;
  }

  const [root, second] = segments.map(segment => segment.toLowerCase());
  if (root === "citresewn") {
    return true;
  }

  if (root !== "optifine" && root !== "mcpatcher") {
    return false;
  }

  return second === "cit" || (segments.length === 1 && fileName.toLowerCase() === "cit.properties");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
