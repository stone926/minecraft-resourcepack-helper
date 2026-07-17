import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";

export interface RsglDiscoveredSourceRoot {
  sourceRoot: string;
  sampleFileName: string;
}

export type RsglWorkspaceSourceRootFileProvider = () => readonly string[] | Promise<readonly string[]>;

interface RsglWorkspaceSourceRootCacheEntry {
  generation: number;
  verifiedAtMs: number;
  roots: RsglDiscoveredSourceRoot[];
}

export interface RsglWorkspaceSourceRootCacheOptions {
  verificationTtlMs?: number;
  now?: () => number;
  pathExists?: (fileName: string) => boolean;
}

export class RsglWorkspaceSourceRootCache {
  private generation = 0;
  private cache: RsglWorkspaceSourceRootCacheEntry | null = null;
  private readonly verificationTtlMs: number;
  private readonly now: () => number;
  private readonly pathExists: (fileName: string) => boolean;

  public constructor(options: RsglWorkspaceSourceRootCacheOptions = {}) {
    this.verificationTtlMs = Math.max(0, options.verificationTtlMs ?? 1_000);
    this.now = options.now ?? Date.now;
    this.pathExists = options.pathExists ?? fs.existsSync;
  }

  public async discover(provider: RsglWorkspaceSourceRootFileProvider): Promise<RsglDiscoveredSourceRoot[]> {
    while (true) {
      const now = this.now();
      if (
        this.cache?.generation === this.generation
        && now >= this.cache.verifiedAtMs
        && now - this.cache.verifiedAtMs < this.verificationTtlMs
        && this.cache.roots.every(root => this.sampleStillExists(root.sampleFileName))
      ) {
        return this.cache.roots;
      }

      const generation = this.generation;
      const roots = discoverRsglSourceRootsFromFileNames(await provider());
      if (generation === this.generation) {
        this.cache = { generation, verifiedAtMs: this.now(), roots };
        return roots;
      }
    }
  }

  public invalidatePath(fileName: string): void {
    if (path.extname(fileName).toLowerCase() === ".rsgl") {
      this.invalidateAll();
    }
  }

  public invalidateAll(): void {
    this.generation++;
    this.cache = null;
  }

  private sampleStillExists(fileName: string): boolean {
    try {
      return this.pathExists(fileName);
    } catch {
      return false;
    }
  }
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
    const key = normalizePathKey(sourceRoot);
    if (!roots.has(key)) {
      roots.set(key, { sourceRoot, sampleFileName: fileName });
    }
  }
  return [...roots.values()].sort((left, right) => compareFileNames(left.sourceRoot, right.sourceRoot));
}

export const rsglWorkspaceSourceRootCache = new RsglWorkspaceSourceRootCache();

function hasIgnoredPathSegment(fileName: string): boolean {
  return path.resolve(fileName).split(path.sep).some(segment => ignoredDirectoryNames.has(segment.toLowerCase()));
}

function compareFileNames(left: string, right: string): number {
  return normalizePathKey(left).localeCompare(normalizePathKey(right));
}

const ignoredDirectoryNames = new Set([".git", ".vscode", "node_modules"]);
