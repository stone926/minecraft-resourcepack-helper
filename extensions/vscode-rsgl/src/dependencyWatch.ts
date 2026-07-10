import * as path from "node:path";

export interface DependencyWatchDisposable {
  dispose(): void;
}

export interface DependencyWatchUpdate {
  added: string[];
  removed: string[];
}

/**
 * Owns an exact-file watcher per normalized dependency path. The registry is
 * transport-agnostic so both the companion API and the LSP client can share
 * the same lifecycle and replacement behavior.
 */
export class DependencyWatchRegistry implements DependencyWatchDisposable {
  private readonly watchers = new Map<string, { fileName: string; disposable: DependencyWatchDisposable }>();

  public constructor(
    private readonly createWatcher: (fileName: string) => DependencyWatchDisposable
  ) {}

  public update(fileNames: readonly string[]): DependencyWatchUpdate {
    const desired = new Map<string, string>();
    for (const fileName of fileNames) {
      const resolved = path.resolve(fileName);
      desired.set(normalizeDependencyPath(resolved), resolved);
    }

    const removed: string[] = [];
    for (const [key, watched] of this.watchers) {
      if (!desired.has(key)) {
        this.watchers.delete(key);
        watched.disposable.dispose();
        removed.push(watched.fileName);
      }
    }

    const added: string[] = [];
    for (const [key, fileName] of desired) {
      if (this.watchers.has(key)) {
        continue;
      }
      const disposable = this.createWatcher(fileName);
      this.watchers.set(key, { fileName, disposable });
      added.push(fileName);
    }
    return { added, removed };
  }

  public dispose(): void {
    for (const watched of this.watchers.values()) {
      watched.disposable.dispose();
    }
    this.watchers.clear();
  }
}

/** Returns true when a dependency path is contained by the supplied root. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Normalizes dependency paths for stable watcher identity comparisons. */
export function normalizeDependencyPath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Converts a dependency list into a normalized identity set. */
export function dependencyPathSet(dependencies: readonly { path: string }[]): Set<string> {
  return new Set(dependencies.map(dependency => normalizeDependencyPath(dependency.path)));
}

/**
 * A build must be verified after its dependency graph expands. Installing the
 * new watchers before that verification closes the interval in which a newly
 * discovered file could change while the asynchronous build was running.
 */
export function dependencyBuildNeedsVerification(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
  invalidatedDuringBuild: ReadonlySet<string>
): boolean {
  for (const dependency of next) {
    if (!previous.has(dependency) || invalidatedDuringBuild.has(dependency)) {
      return true;
    }
  }
  return false;
}
