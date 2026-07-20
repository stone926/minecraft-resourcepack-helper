import * as path from "node:path";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import {
  compileDependencyPatternMatchesPath,
  compileDependencyPatternProbePath,
  compileDependencyWatchPatternKey,
  normalizeCompileDependencyWatchPattern,
  rebaseCompileDependencyWatchPattern,
  type CompileDependencyWatchPattern
} from "../../../packages/rsgl-core/src/compiler/compileDependencies";
import type { RsglDependencyWatchPattern } from "../../../packages/rsgl-shared/src";

export interface DependencyWatchDisposable {
  dispose(): void;
}

export interface DependencyWatchUpdate {
  added: string[];
  removed: string[];
}

export interface DependencyPatternWatchUpdate {
  added: RsglDependencyWatchPattern[];
  removed: RsglDependencyWatchPattern[];
}

/**
 * Owns an exact-file watcher per normalized dependency path. The registry is
 * transport-agnostic so project configuration and LSP dependencies share the
 * same lifecycle and replacement behavior.
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

/** Owns one targeted RelativePattern watcher per normalized glob dependency. */
export class DependencyPatternWatchRegistry implements DependencyWatchDisposable {
  private readonly watchers = new Map<string, {
    pattern: RsglDependencyWatchPattern;
    disposable: DependencyWatchDisposable;
  }>();

  public constructor(
    private readonly createWatcher: (pattern: RsglDependencyWatchPattern) => DependencyWatchDisposable
  ) {}

  public update(patterns: readonly RsglDependencyWatchPattern[]): DependencyPatternWatchUpdate {
    const desired = new Map<string, RsglDependencyWatchPattern>();
    for (const pattern of patterns) {
      if (!isValidDependencyWatchPattern(pattern)) {
        continue;
      }
      const normalized = normalizeCompileDependencyWatchPattern(pattern);
      desired.set(compileDependencyWatchPatternKey(normalized), normalized);
    }

    const removed: RsglDependencyWatchPattern[] = [];
    for (const [key, watched] of this.watchers) {
      if (!desired.has(key)) {
        this.watchers.delete(key);
        watched.disposable.dispose();
        removed.push(watched.pattern);
      }
    }

    const added: RsglDependencyWatchPattern[] = [];
    for (const [key, pattern] of desired) {
      if (this.watchers.has(key)) {
        continue;
      }
      const disposable = this.createWatcher(pattern);
      this.watchers.set(key, { pattern, disposable });
      added.push(pattern);
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
  return normalizePathKey(path.resolve(fileName));
}

export {
  compileDependencyPatternMatchesPath as dependencyPatternMatchesPath,
  compileDependencyPatternProbePath as dependencyPatternProbePath,
  normalizeCompileDependencyWatchPattern as normalizeDependencyWatchPattern,
  rebaseCompileDependencyWatchPattern as rebaseDependencyWatchPattern
};

/**
 * Creates a VS Code RelativePattern for one exact dependency. VS Code treats
 * glob metacharacters in a basename as syntax, so static path characters are
 * widened to one-character wildcards and the server performs the exact check.
 */
export function vscodeExactDependencyWatchPattern(
  fileName: string,
  pathExists: (candidate: string) => boolean
): CompileDependencyWatchPattern {
  const rebased = rebaseCompileDependencyWatchPattern({
    basePath: path.dirname(fileName),
    pattern: path.basename(fileName)
  }, pathExists);
  return {
    basePath: rebased.basePath,
    pattern: vscodeSafeStaticPattern(rebased.pattern)
  };
}

/**
 * Converts RSGL's `*`, `**`, and `?` grammar to a safe VS Code superset.
 * Braces and brackets are literals in RSGL but operators in VS Code; replacing
 * them with `?` guarantees the real path is observed before server-side
 * dependency matching filters the event.
 */
export function vscodeGlobDependencyWatchPattern(
  pattern: CompileDependencyWatchPattern,
  pathExists: (candidate: string) => boolean
): CompileDependencyWatchPattern {
  const normalized = normalizeCompileDependencyWatchPattern(pattern);
  const rebased = rebaseCompileDependencyWatchPattern(normalized, pathExists);
  const staticPrefix = path.relative(rebased.basePath, normalized.basePath).replaceAll("\\", "/");
  return {
    basePath: rebased.basePath,
    pattern: [
      staticPrefix ? vscodeSafeStaticPattern(staticPrefix) : "",
      vscodeSafeRsglGlobPattern(normalized.pattern)
    ].filter(Boolean).join("/")
  };
}

function vscodeSafeStaticPattern(pattern: string): string {
  return pattern.replaceAll(/[?*[\]{}]/g, "?");
}

function vscodeSafeRsglGlobPattern(pattern: string): string {
  const segments = pattern.split("/");
  const embeddedGlobstar = segments.findIndex(segment =>
    segment.includes("**") && segment !== "**"
  );
  const safeSegments = embeddedGlobstar < 0
    ? segments
    : [...segments.slice(0, embeddedGlobstar), "**"];
  return safeSegments
    .filter((segment, index) => segment !== "**" || safeSegments[index - 1] !== "**")
    .map(segment => segment.replaceAll(/[[\]{}]/g, "?"))
    .join("/");
}

/** Rejects absolute or parent-traversing patterns before creating a watcher. */
export function isValidDependencyWatchPattern(value: unknown): value is RsglDependencyWatchPattern {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { basePath, pattern } = value as Partial<RsglDependencyWatchPattern>;
  if (
    typeof basePath !== "string"
    || basePath.length === 0
    || typeof pattern !== "string"
    || pattern.length === 0
    || path.isAbsolute(pattern)
  ) {
    return false;
  }
  return !pattern.replaceAll("\\", "/").split("/").includes("..");
}

/** Returns true when a dependency is not covered by the workspace RSGL source glob. */
export function requiresExactDependencyWatcher(fileName: string, isInWorkspace: boolean): boolean {
  if (!isInWorkspace) {
    return true;
  }
  const extension = path.extname(fileName).toLowerCase();
  return extension !== ".rsgl";
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
