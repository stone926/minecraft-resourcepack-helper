import * as path from "node:path";
import { isModelDocumentPath, isResourceGraphDocumentPath } from "./resourceGraphSearch";

export const resourceGraphConfiguredRootMaxDepth = 32;

export interface ResourceGraphDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type ResourceGraphDirectoryReader = (
  directory: string
) => Promise<readonly ResourceGraphDirectoryEntry[] | null>;

export interface ResourceGraphPathSnapshot {
  readonly resourceReferencePaths: string[];
  readonly modelDocumentPaths: string[];
  readonly blockstatePaths: string[];
}

export interface ResourceGraphRootScanOptions {
  readonly maxDepth?: number;
  readonly includeBlockstates?: boolean;
}

export async function collectResourceGraphPathsInRoot(
  root: string,
  readDirectory: ResourceGraphDirectoryReader,
  options: ResourceGraphRootScanOptions = {}
): Promise<ResourceGraphPathSnapshot> {
  const snapshot = createMutableSnapshot();
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  await collectDirectory(root, 0, maxDepth, options.includeBlockstates ?? false, readDirectory, snapshot);
  return snapshot;
}

export function classifyResourceGraphPaths(
  fileNames: readonly string[],
  options: Pick<ResourceGraphRootScanOptions, "includeBlockstates"> = {}
): ResourceGraphPathSnapshot {
  const snapshot = createMutableSnapshot();
  for (const fileName of fileNames) {
    addResourceGraphPath(snapshot, fileName, options.includeBlockstates ?? false);
  }
  return snapshot;
}

function createMutableSnapshot(): ResourceGraphPathSnapshot {
  return {
    resourceReferencePaths: [],
    modelDocumentPaths: [],
    blockstatePaths: []
  };
}

async function collectDirectory(
  directory: string,
  depth: number,
  maxDepth: number,
  includeBlockstates: boolean,
  readDirectory: ResourceGraphDirectoryReader,
  snapshot: ResourceGraphPathSnapshot
): Promise<void> {
  const entries = await readDirectory(directory);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile()) {
      addResourceGraphPath(snapshot, entryPath, includeBlockstates);
    } else if (
      entry.isDirectory() &&
      depth < maxDepth &&
      !shouldSkipDirectory(entry.name)
    ) {
      await collectDirectory(entryPath, depth + 1, maxDepth, includeBlockstates, readDirectory, snapshot);
    }
  }
}

function addResourceGraphPath(
  snapshot: ResourceGraphPathSnapshot,
  fileName: string,
  includeBlockstates: boolean
): void {
  if (isResourceGraphDocumentPath(fileName)) {
    snapshot.resourceReferencePaths.push(fileName);
  }
  if (isModelDocumentPath(fileName)) {
    snapshot.modelDocumentPaths.push(fileName);
  }
  if (includeBlockstates && isBlockstateDocumentPath(fileName)) {
    snapshot.blockstatePaths.push(fileName);
  }
}

function normalizeMaxDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return resourceGraphConfiguredRootMaxDepth;
  }
  return Math.max(0, Math.floor(value));
}

function shouldSkipDirectory(name: string): boolean {
  return ignoredDirectoryNames.has(name.toLowerCase());
}

export function isBlockstateDocumentPath(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]blockstates[\\/][^\\/]+\.json$/i.test(fileName);
}

const ignoredDirectoryNames = new Set([".git", "node_modules", "out"]);
