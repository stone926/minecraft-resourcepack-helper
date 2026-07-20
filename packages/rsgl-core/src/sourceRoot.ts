import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import { isRsglPathInsideOrEqual } from "./pathIdentity";

export interface RsglDiscoveredSourceRoot {
  sourceRoot: string;
  sampleFileName: string;
}

export type RsglWorkspaceSourceRootFileProvider = () => readonly string[] | Promise<readonly string[]>;
export type RsglSourceRootResolver = (fileName: string) => string;

interface RsglWorkspaceSourceRootCacheEntry {
  generation: number;
  verifiedAtMs: number;
  resolver: RsglSourceRootResolver;
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

  public async discover(
    provider: RsglWorkspaceSourceRootFileProvider,
    resolver: RsglSourceRootResolver = resolveRsglSourceRootFromFileName
  ): Promise<RsglDiscoveredSourceRoot[]> {
    while (true) {
      const now = this.now();
      if (
        this.cache?.generation === this.generation
        && this.cache.resolver === resolver
        && now >= this.cache.verifiedAtMs
        && now - this.cache.verifiedAtMs < this.verificationTtlMs
        && this.cache.roots.every(root => this.sampleStillExists(root.sampleFileName))
      ) {
        return this.cache.roots;
      }

      const generation = this.generation;
      const roots = discoverRsglSourceRootsFromFileNames(await provider(), resolver);
      if (generation === this.generation) {
        this.cache = { generation, verifiedAtMs: this.now(), resolver, roots };
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

export interface RsglNavigationSourceRootOptions {
  /** Absolute root explicitly selected by rsgl.config.json. */
  configuredRoot?: string;
  /** Known config-project and initialized-workspace boundaries. */
  projectRoots?: readonly string[];
}

/**
 * Resolves the bounded directory required for reverse-import navigation.
 * Explicit project configuration wins. Otherwise, the closest containing
 * conventional `src`, config-project, or initialized-workspace boundary is
 * used. Choosing the closest boundary lets a project nested under an outer
 * `src` remain isolated while still finding sibling importers in a no-config,
 * no-`src` workspace.
 */
export function resolveRsglNavigationSourceRoot(
  fileName: string,
  options: RsglNavigationSourceRootOptions = {}
): string {
  const resolvedFileName = path.resolve(fileName);
  if (
    options.configuredRoot
    && isRsglPathInsideOrEqual(resolvedFileName, options.configuredRoot)
  ) {
    return path.resolve(options.configuredRoot);
  }

  const conventionalRoot = resolveRsglSourceRootFromFileName(resolvedFileName);
  const containingProjectRoots = (options.projectRoots ?? [])
    .map(root => path.resolve(root))
    .filter(root => isRsglPathInsideOrEqual(resolvedFileName, root))
    .sort((left, right) => pathDepth(right) - pathDepth(left) || right.length - left.length);
  const hasConventionalRoot = path.basename(conventionalRoot).toLowerCase() === "src";
  if (!hasConventionalRoot) {
    return containingProjectRoots[0] ?? conventionalRoot;
  }

  return [conventionalRoot, ...containingProjectRoots]
    .sort((left, right) => pathDepth(right) - pathDepth(left) || right.length - left.length)[0];
}

export function discoverRsglSourceRootsFromFileNames(
  fileNames: readonly string[],
  resolver: RsglSourceRootResolver = resolveRsglSourceRootFromFileName
): RsglDiscoveredSourceRoot[] {
  const roots = new Map<string, RsglDiscoveredSourceRoot>();
  for (const fileName of [...fileNames].map(item => path.resolve(item)).sort(compareFileNames)) {
    if (path.extname(fileName).toLowerCase() !== ".rsgl" || hasIgnoredPathSegment(fileName)) {
      continue;
    }

    const sourceRoot = path.resolve(resolver(fileName));
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

function pathDepth(fileName: string): number {
  return path.resolve(fileName).split(path.sep).filter(Boolean).length;
}

const ignoredDirectoryNames = new Set([".git", ".vscode", "node_modules"]);
