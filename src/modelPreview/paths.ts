import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePathKey } from "../../packages/mc-assets/src";

export function fileUriString(fileName: string): string {
  return pathToFileURL(path.resolve(fileName)).href;
}

export function dependencyKey(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return normalizePathKey(fileURLToPath(value));
    } catch {
      return value.toLowerCase();
    }
  }

  return normalizePathKey(value);
}
