import * as path from "node:path";

export interface RsglDiscoveredSourceRoot {
  sourceRoot: string;
  sampleFileName: string;
}

export function resolveRsglSourceRootFromFileName(fileName: string): string {
  const resolvedFileName = path.resolve(fileName);
  let directory = path.dirname(resolvedFileName);

  while (true) {
    if (path.basename(directory).toLowerCase() === "src") {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return path.dirname(resolvedFileName);
    }
    directory = parent;
  }
}

export function discoverRsglSourceRootsFromFileNames(fileNames: readonly string[]): RsglDiscoveredSourceRoot[] {
  const roots = new Map<string, RsglDiscoveredSourceRoot>();
  for (const fileName of [...fileNames].map(item => path.resolve(item)).sort(compareFileNames)) {
    if (path.extname(fileName).toLowerCase() !== ".rsgl" || hasIgnoredPathSegment(fileName)) {
      continue;
    }

    const sourceRoot = resolveRsglSourceRootFromFileName(fileName);
    const key = pathKey(sourceRoot);
    if (!roots.has(key)) {
      roots.set(key, { sourceRoot, sampleFileName: fileName });
    }
  }
  return [...roots.values()].sort((left, right) => compareFileNames(left.sourceRoot, right.sourceRoot));
}

function hasIgnoredPathSegment(fileName: string): boolean {
  return path.resolve(fileName).split(path.sep).some(segment => ignoredDirectoryNames.has(segment.toLowerCase()));
}

function compareFileNames(left: string, right: string): number {
  return pathKey(left).localeCompare(pathKey(right));
}

function pathKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const ignoredDirectoryNames = new Set([".git", ".vscode", "node_modules"]);
