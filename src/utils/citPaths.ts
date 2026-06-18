import * as path from "node:path";

export type CitResourceType = "textures" | "models";

export function getCitResourceType(key: string): CitResourceType | null {
  if (/^texture(\.|$)/.test(key)) {
    return "textures";
  }

  if (/^model(\.|$)/.test(key)) {
    return "models";
  }

  return null;
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
    return [withExtension(cleanValue, resourceType)];
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
      resourceType,
      withExtension(resourceLocation.resourcePath, resourceType)
    ));
    return unique(candidates);
  }

  candidates.push(path.join(documentDirectory, withExtension(normalizedValue, resourceType)));
  candidates.push(path.join(packRoot, "assets", "minecraft", resourceType, withExtension(normalizedValue, resourceType)));
  return unique(candidates);
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
