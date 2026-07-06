import * as path from "node:path";

export function normalizePathKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSamePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function uniqueNormalizedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fileName of paths) {
    const key = normalizePathKey(fileName);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(path.normalize(fileName));
    }
  }
  return result;
}
