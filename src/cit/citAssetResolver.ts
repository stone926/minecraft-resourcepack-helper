import * as path from "node:path";
import { packRootFromAssetsPath, startsWithPathSegment } from "../../packages/mc-assets/src";
import {
  getCitAutoDiscoveryPathCandidates,
  getCitPathCandidates,
  hasExplicitRelativePathPrefix
} from "./citPaths";
import type { CitResourceType } from "./citKeyResolution";

export type CitAssetResolutionType = CitResourceType | "auto";

export interface CitAssetResolutionHost {
  pathExists(fileName: string): boolean;
  getPackRoot?(fileName: string): string | null;
}

export interface CitReferenceAsset {
  value: string;
  target: string;
  extension: string | null;
  origin?: string;
}

export interface CitReferenceAssetResolutionHost extends CitAssetResolutionHost {
  resolveTypedResource?(reference: CitReferenceAsset): string | null;
}

export function citResourceTypeFor(target: string, extension: string | null): CitResourceType | null {
  if (target === "textures" && extension === "png") {
    return "textures";
  }

  if (target === "models" && extension === "json") {
    return "models";
  }

  return null;
}

export function getCitAssetCandidates(
  sourceFileName: string,
  value: string,
  resourceType: CitAssetResolutionType,
  host: CitAssetResolutionHost
): string[] {
  const packRoot = host.getPackRoot?.(sourceFileName) ?? packRootFromAssetsPath(sourceFileName);
  if (!packRoot) {
    return [];
  }

  return resourceType === "auto"
    ? getCitAutoDiscoveryPathCandidates(sourceFileName, packRoot, value)
    : getCitPathCandidates(sourceFileName, packRoot, value, resourceType);
}

export function resolveCitAsset(
  sourceFileName: string,
  value: string,
  resourceType: CitAssetResolutionType,
  host: CitAssetResolutionHost
): string | null {
  return getCitAssetCandidates(sourceFileName, value, resourceType, host)
    .find(candidate => host.pathExists(candidate)) ?? null;
}

export function resolveCitReferenceAsset(
  sourceFileName: string,
  reference: CitReferenceAsset,
  host: CitReferenceAssetResolutionHost
): string | null {
  if (reference.origin === "citAutoDiscovery") {
    return resolveCitAsset(sourceFileName, reference.value, "auto", host);
  }

  const resourceType = citResourceTypeFor(reference.target, reference.extension);
  if (!resourceType) {
    return null;
  }

  const resolved = resolveCitAsset(sourceFileName, reference.value, resourceType, host);
  if (resolved || !shouldTryTypedResourceFallback(reference.value)) {
    return resolved;
  }

  return host.resolveTypedResource?.(reference) ?? null;
}

function shouldTryTypedResourceFallback(value: string): boolean {
  const cleanValue = value.trim();
  if (cleanValue.length === 0 || path.isAbsolute(cleanValue)) {
    return false;
  }

  const normalizedValue = cleanValue.replace(/[\\/]+/g, path.sep);
  return !startsWithPathSegment(normalizedValue, "assets") &&
    !hasExplicitRelativePathPrefix(normalizedValue);
}
