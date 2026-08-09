import * as path from "node:path";
import { getAssetsResource } from "./packResolution";
import {
  minecraftResourceIdToString,
  tryParseMinecraftResourceId
} from "./resourceId";
import { stripPathExtension } from "./pathSegments";

export interface AssetsResourceIdOptions {
  /** Select only the file name when the containing source directory is not part of the logical id. */
  pathMode?: "resourcePath" | "basename";
  /** Remove the first matching complete path prefix before constructing the logical id. */
  stripPathPrefixes?: readonly string[];
  /** Reject assets whose resource path does not start with one of the configured prefixes. */
  requirePathPrefix?: boolean;
}

/**
 * Infers a validated Minecraft resource id from a physical file below
 * `assets/<namespace>`. Callers explicitly describe which source-directory
 * prefixes are not part of the logical resource path.
 */
export function inferMinecraftResourceIdFromAssetsFile(
  fileName: string,
  options: AssetsResourceIdOptions = {}
): string | null {
  const asset = getAssetsResource(fileName);
  if (!asset) {
    return null;
  }

  const normalizedPath = asset.resourcePath.replaceAll("\\", "/");
  let resourcePath: string;
  if (options.pathMode === "basename") {
    resourcePath = path.posix.basename(normalizedPath);
  } else {
    const matchingPrefix = options.stripPathPrefixes
      ?.map(normalizeResourcePathPrefix)
      .find(prefix => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
    if (options.requirePathPrefix && !matchingPrefix) {
      return null;
    }
    resourcePath = matchingPrefix
      ? normalizedPath.slice(matchingPrefix.length).replace(/^\/+/, "")
      : normalizedPath;
  }

  const parsed = tryParseMinecraftResourceId(
    `${asset.namespace}:${stripPathExtension(resourcePath)}`
  );
  return parsed ? minecraftResourceIdToString(parsed) : null;
}

function normalizeResourcePathPrefix(prefix: string): string {
  return prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}
