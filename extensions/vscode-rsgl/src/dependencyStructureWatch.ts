import * as path from "node:path";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import {
  compileDependencyPathContains,
  compileDependencyPatternMatchesPath,
  compileDependencyPatternStructurallyMatchesPath,
  compileDependencyStructuralWatchPatterns,
  compileDependencyWatchPatternKey,
  normalizeCompileDependencyWatchPattern,
  type CompileDependencyWatchPattern
} from "../../../packages/rsgl-core/src/compiler/compileDependencies";
import type { RsglDependencyWatchPattern } from "../../../packages/rsgl-shared/src";
import type { DependencyWatchDisposable } from "./dependencyWatch";

export type DependencyStructureWatchSelector =
  | { kind: "ancestor"; path: string }
  | { kind: "pattern-prefix"; pattern: CompileDependencyWatchPattern };

export interface DependencyStructureWatchUpdate {
  added: DependencyStructureWatchSelector[];
  removed: DependencyStructureWatchSelector[];
}

/**
 * Owns narrow create/delete watchers for directories that can structurally
 * add or remove exact and glob dependencies. Ancestor selectors are exact;
 * glob selectors contain only directory prefixes of the published pattern.
 */
export class DependencyStructureWatchRegistry implements DependencyWatchDisposable {
  private readonly watchers = new Map<string, {
    selector: DependencyStructureWatchSelector;
    disposable: DependencyWatchDisposable;
  }>();
  private exactPaths = new Map<string, string>();
  private patterns: CompileDependencyWatchPattern[] = [];

  public constructor(
    private readonly createWatcher: (
      selector: DependencyStructureWatchSelector
    ) => DependencyWatchDisposable
  ) {}

  public update(
    fileNames: readonly string[],
    patterns: readonly RsglDependencyWatchPattern[]
  ): DependencyStructureWatchUpdate {
    this.exactPaths = new Map(fileNames.map(fileName => {
      const resolved = path.resolve(fileName);
      return [normalizePathKey(resolved), resolved];
    }));
    this.patterns = patterns.map(normalizeCompileDependencyWatchPattern);

    const desired = new Map<string, DependencyStructureWatchSelector>();
    for (const fileName of this.exactPaths.values()) {
      addAncestorSelectors(path.dirname(fileName), desired);
    }
    for (const pattern of this.patterns) {
      addAncestorSelectors(pattern.basePath, desired);
      for (const prefix of compileDependencyStructuralWatchPatterns(pattern)) {
        const selector: DependencyStructureWatchSelector = {
          kind: "pattern-prefix",
          pattern: prefix
        };
        desired.set(structureSelectorKey(selector), selector);
      }
    }

    const removed: DependencyStructureWatchSelector[] = [];
    for (const [key, watched] of this.watchers) {
      if (!desired.has(key)) {
        this.watchers.delete(key);
        watched.disposable.dispose();
        removed.push(watched.selector);
      }
    }

    const added: DependencyStructureWatchSelector[] = [];
    for (const [key, selector] of desired) {
      if (this.watchers.has(key)) {
        continue;
      }
      const disposable = this.createWatcher(selector);
      this.watchers.set(key, { selector, disposable });
      added.push(selector);
    }
    return { added, removed };
  }

  /** Returns whether the normal exact/pattern watcher already covers a path. */
  public directlyDependsOnPath(fileName: string): boolean {
    const normalized = normalizePathKey(path.resolve(fileName));
    return this.exactPaths.has(normalized)
      || this.patterns.some(pattern => compileDependencyPatternMatchesPath(pattern, fileName));
  }

  /** Returns whether a create/delete path can structurally change dependencies. */
  public structurallyDependsOnPath(fileName: string): boolean {
    return this.exactAncestorDependsOnPath(fileName)
      || this.patterns.some(pattern =>
        compileDependencyPatternStructurallyMatchesPath(pattern, fileName)
      );
  }

  /**
   * Filters structural watcher events before transport. Creates from glob
   * prefixes must be directories; exact ancestors also care about a blocking
   * file. Deleted paths have no remaining file type and are kept conservatively.
   */
  public shouldForwardEvent(
    fileName: string,
    type: "create" | "delete",
    isDirectory: boolean
  ): boolean {
    if (this.exactAncestorDependsOnPath(fileName)) {
      return true;
    }
    const patternStructural = this.patterns.some(pattern =>
      compileDependencyPatternStructurallyMatchesPath(pattern, fileName)
    );
    return patternStructural && (type === "delete" || isDirectory);
  }

  public dispose(): void {
    for (const watched of this.watchers.values()) {
      watched.disposable.dispose();
    }
    this.watchers.clear();
    this.exactPaths.clear();
    this.patterns = [];
  }

  private exactAncestorDependsOnPath(fileName: string): boolean {
    const candidateKey = normalizePathKey(path.resolve(fileName));
    for (const [exactKey, exactPath] of this.exactPaths) {
      if (candidateKey !== exactKey && compileDependencyPathContains(fileName, exactPath)) {
        return true;
      }
    }
    return false;
  }
}

function addAncestorSelectors(
  directory: string,
  selectors: Map<string, DependencyStructureWatchSelector>
): void {
  let current = path.resolve(directory);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    const selector: DependencyStructureWatchSelector = { kind: "ancestor", path: current };
    selectors.set(structureSelectorKey(selector), selector);
    current = parent;
  }
}

function structureSelectorKey(selector: DependencyStructureWatchSelector): string {
  return selector.kind === "ancestor"
    ? `ancestor\0${normalizePathKey(selector.path)}`
    : `pattern\0${compileDependencyWatchPatternKey(selector.pattern)}`;
}
