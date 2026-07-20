import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ResourceProjectFileType,
  ResourceProjectTopologyHost,
  SerializedResourceUri
} from "./types";
import { normalizeResourceProjectUri } from "./uri";

export class NodeResourceProjectTopologyHost implements ResourceProjectTopologyHost {
  public async stat(uri: SerializedResourceUri): Promise<ResourceProjectFileType | null> {
    const fileName = resourceProjectUriToNodePath(uri);
    try {
      const result = await fs.stat(fileName);
      if (result.isFile()) {
        return "file";
      }
      if (result.isDirectory()) {
        return "directory";
      }
      return null;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }
}

export function nodePathToResourceProjectUri(fileName: string): SerializedResourceUri {
  return normalizeResourceProjectUri(pathToFileURL(path.resolve(fileName)).toString());
}

export function resourceProjectUriToNodePath(uri: SerializedResourceUri): string {
  const normalized = normalizeResourceProjectUri(uri);
  const url = new URL(normalized);
  if (url.protocol !== "file:") {
    throw new Error(`Node filesystem adapter only supports file URIs: ${uri}`);
  }
  return fileURLToPath(url);
}

function isFileNotFoundError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
